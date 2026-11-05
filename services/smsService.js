const https = require("https");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");

/**
 * Normalizes phone numbers to standard 10-digit Indian mobile format.
 *
 * @param {string|number} value
 * @returns {string|null}
 */
function normalizePhone(value) {
    if (!value) return null;
    let phone = String(value).trim().replace(/[\s()-]/g, "");
    if (phone.startsWith("+91")) phone = phone.slice(3);
    else if (phone.startsWith("0091")) phone = phone.slice(4);
    else if (phone.startsWith("91") && phone.length === 12) phone = phone.slice(2);
    return /^\d{10}$/.test(phone) ? phone : null;
}

/**
 * Generates a cryptographically secure 6-digit numeric OTP.
 *
 * @returns {string}
 */
function generateOtp() {
    return String(crypto.randomInt(100000, 1000000));
}

/**
 * Creates a timing-safe hash of the OTP for secure database storage.
 *
 * @param {string} phone
 * @param {string} otp
 * @returns {string}
 */
function hashOtp(phone, otp) {
    const secret = process.env.SESSION_SECRET || "aak_clothing_otp_salt";
    return crypto.createHmac("sha256", secret).update(`${phone}:${otp}`).digest("hex");
}

/**
 * Low-level HTTP requester to MSG91 SMS Gateway for Mobile OTP.
 * Never prints or exposes secret credentials.
 *
 * @param {Object} options
 * @param {string} options.phone - 10-digit mobile number
 * @param {string} options.otp - 6-digit OTP
 * @param {string} [options.purpose]
 * @returns {Promise<{ success: boolean, message: string, raw?: Object, simulated?: boolean }>}
 */
function sendMsg91Otp({ phone, otp, purpose = "verification" }) {
    return new Promise((resolve, reject) => {
        const authKey = process.env.MSG91_AUTH_KEY;
        const templateId = process.env.MSG91_OTP_TEMPLATE_ID;

        // If credentials are not configured (e.g. local test/dev mode), securely simulate delivery
        if (!authKey || !templateId) {
            console.log(`[MSG91 SMS Gateway] (SIMULATED): OTP sent to +91-${phone} for purpose '${purpose}'`);
            return resolve({
                success: true,
                simulated: true,
                message: "OTP sent via simulated MSG91 SMS gateway"
            });
        }

        const formattedMobile = `91${phone}`;
        const expiryMinutes = Number(process.env.MSG91_OTP_EXPIRY_MINUTES) || 10;

        const payload = JSON.stringify({
            template_id: templateId,
            mobile: formattedMobile,
            otp: String(otp),
            otp_length: 6,
            otp_expiry: expiryMinutes
        });

        const req = https.request({
            hostname: "control.msg91.com",
            path: "/api/v5/otp",
            method: "POST",
            headers: {
                authkey: authKey,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
            }
        }, response => {
            let data = "";
            response.on("data", chunk => data += chunk);
            response.on("end", () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    parsed = { message: data };
                }

                if (response.statusCode >= 200 && response.statusCode < 300) {
                    resolve({
                        success: true,
                        simulated: false,
                        message: parsed.message || "OTP sent successfully via MSG91 SMS",
                        raw: parsed
                    });
                } else {
                    const errMsg = parsed?.message || parsed?.error || `MSG91 HTTP error ${response.statusCode}`;
                    reject(new Error(errMsg));
                }
            });
        });

        req.setTimeout(15000, () => {
            req.destroy(new Error("MSG91 request timed out after 15 seconds"));
        });

        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

/**
 * Creates, stores, and sends an OTP to a mobile phone with rate limiting and security checks.
 *
 * @param {Object} options
 * @param {import('mongodb').Db} options.db
 * @param {string} options.phone
 * @param {string} options.purpose - "registration" | "phone_verification" | "phone_change" | "forgot_password"
 * @param {Object} [options.metadata] - Optional additional state
 * @param {Function} [options.smsSender] - Injected sender for testing
 * @returns {Promise<{ success: boolean, message: string, phone?: string, cooldownSeconds?: number, cooldownRemaining?: number, expiresAt?: Date, simulatedOtp?: string, otp?: string }>}
 */
async function createAndSendOtp({ db, phone, purpose = "registration", metadata = {}, smsSender = sendMsg91Otp }) {
    const validPhone = normalizePhone(phone);
    if (!validPhone) {
        return { success: false, message: "Invalid 10-digit mobile number" };
    }

    const now = new Date();
    const expiryMinutes = Number(process.env.MSG91_OTP_EXPIRY_MINUTES) || 10;
    const expiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000);

    // Rate Limiting: Check previous active OTP for cooldown (min 60 seconds) and max resends (max 3)
    const existingOtp = await db.collection("otps").findOne({
        phone: validPhone,
        purpose,
        verified: { $ne: true },
        expiresAt: { $gt: now }
    });

    let resendCount = 0;
    if (existingOtp) {
        const lastSent = existingOtp.lastResentAt || existingOtp.createdAt;
        const secondsSinceLastSent = Math.floor((now.getTime() - new Date(lastSent).getTime()) / 1000);

        if (secondsSinceLastSent < 60) {
            const waitSeconds = 60 - secondsSinceLastSent;
            return {
                success: false,
                cooldownSeconds: waitSeconds,
                cooldownRemaining: waitSeconds,
                message: `Please wait ${waitSeconds} seconds before requesting a new OTP.`
            };
        }

        if (existingOtp.resendCount >= 3) {
            return {
                success: false,
                message: "Maximum OTP resend limit reached. Please try again after 10 minutes."
            };
        }

        resendCount = (existingOtp.resendCount || 0) + 1;
    }

    // Generate secure 6-digit OTP
    const otp = generateOtp();
    const otpHash = hashOtp(validPhone, otp);

    // Send mobile OTP via MSG91 SMS Gateway
    let sendResult;
    try {
        sendResult = await smsSender({ phone: validPhone, otp, purpose });
    } catch (err) {
        console.error(`[MSG91 SMS Error]: Failed to dispatch SMS to ${validPhone}:`, err.message);
        return {
            success: false,
            message: `Failed to deliver SMS OTP: ${err.message}`
        };
    }

    // Upsert the OTP document in MongoDB Atlas
    await db.collection("otps").updateOne(
        { phone: validPhone, purpose },
        {
            $set: {
                phone: validPhone,
                otpHash,
                purpose,
                metadata,
                attempts: 0,
                resendCount,
                lastResentAt: now,
                expiresAt,
                verified: false
            },
            $setOnInsert: {
                createdAt: now
            }
        },
        { upsert: true }
    );

    return {
        success: true,
        phone: validPhone,
        message: "OTP sent successfully to your mobile number via SMS.",
        expiresAt,
        cooldownSeconds: 60,
        // In simulation/test environments only, expose simulatedOtp and otp for deterministic testing
        simulatedOtp: sendResult.simulated ? otp : undefined,
        otp: (sendResult.simulated || process.env.NODE_ENV === "test") ? otp : undefined
    };
}

/**
 * Verifies an OTP entered by the user.
 *
 * @param {Object} options
 * @param {import('mongodb').Db} options.db
 * @param {string} options.phone
 * @param {string} options.otp
 * @param {string} options.purpose
 * @returns {Promise<{ success: boolean, message: string, attemptsRemaining?: number, metadata?: Object }>}
 */
async function verifyOtp({ db, phone, otp, purpose = "registration" }) {
    const validPhone = normalizePhone(phone);
    if (!validPhone) {
        return { success: false, message: "Invalid 10-digit mobile number" };
    }

    const cleanOtp = String(otp || "").trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
        return { success: false, message: "Please enter a valid 6-digit OTP" };
    }

    const now = new Date();
    const record = await db.collection("otps").findOne({
        phone: validPhone,
        purpose,
        verified: { $ne: true }
    });

    if (!record) {
        return { success: false, message: "No active OTP request found. Please request a new OTP." };
    }

    if (new Date(record.expiresAt) < now) {
        return { success: false, message: "OTP has expired. Please request a new OTP." };
    }

    if ((record.attempts || 0) >= 5) {
        return { success: false, message: "Too many failed attempts. Please request a new OTP." };
    }

    const expectedHash = hashOtp(validPhone, cleanOtp);
    const expectedBuf = Buffer.from(expectedHash, "utf8");
    const actualBuf = Buffer.from(record.otpHash, "utf8");

    const matches = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

    if (!matches) {
        await db.collection("otps").updateOne(
            { _id: record._id },
            { $inc: { attempts: 1 } }
        );
        const remaining = 5 - ((record.attempts || 0) + 1);
        return {
            success: false,
            attemptsRemaining: remaining,
            message: `Invalid OTP. ${remaining > 0 ? remaining + " attempt(s) remaining." : "Maximum attempts reached. Please request a new OTP."}`
        };
    }

    // Mark as verified atomically
    await db.collection("otps").updateOne(
        { _id: record._id },
        {
            $set: {
                verified: true,
                verifiedAt: now
            }
        }
    );

    return {
        success: true,
        message: "Mobile number verified successfully.",
        metadata: record.metadata || {}
    };
}

module.exports = {
    normalizePhone,
    generateOtp,
    hashOtp,
    sendMsg91Otp,
    createAndSendOtp,
    verifyOtp
};
