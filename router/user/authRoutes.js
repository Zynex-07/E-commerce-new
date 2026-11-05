const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");
const crypto = require("crypto");
const { createAndSendOtp, verifyOtp, normalizePhone } = require("../../services/smsService");
const { sendNewCustomerRegistrationAdminEmail } = require("../../services/emailService");

function safeText(value) {
    return String(value ?? "").trim();
}

function renderLogin(res, error = null, message = null) {
    return res.status(error ? 400 : 200).render("auth/login", {
        error,
        message
    });
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derivedKey = crypto.scryptSync(password, salt, 64).toString("hex");
    return `scrypt$${salt}$${derivedKey}`;
}

function verifyPassword(password, storedPassword) {
    const stored = String(storedPassword || "");

    if (!stored.startsWith("scrypt$")) {
        // Backward compatibility for old plaintext-password accounts.
        return stored === password;
    }

    const parts = stored.split("$");
    if (parts.length !== 3) return false;

    const [, salt, expectedHex] = parts;

    try {
        const actual = crypto.scryptSync(password, salt, 64);
        const expected = Buffer.from(expectedHex, "hex");
        return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

function validPassword(password) {
    return typeof password === "string" && password.length >= 6;
}

// ==========================================
// REGISTRATION FLOW (WITH MSG91 MOBILE OTP)
// ==========================================

router.get("/signup", (req, res) => {
    res.render("auth/signup", {
        error: null,
        form: { username: "", phone: "" }
    });
});

router.post("/signup", async (req, res) => {
    try {
        const db = getDB();

        const username = safeText(req.body.username);
        const usernameKey = username.toLowerCase();
        const phone = normalizePhone(req.body.phone);
        const password = String(req.body.password || "");
        const confirmPassword = String(req.body.confirmPassword || "");

        const form = { username, phone: safeText(req.body.phone) };

        if (!username || !phone || !password || !confirmPassword) {
            return res.status(400).render("auth/signup", {
                error: "All fields are required.",
                form
            });
        }

        if (!/^[A-Za-z0-9_ ]{3,30}$/.test(username)) {
            return res.status(400).render("auth/signup", {
                error: "Username must be 3–30 characters and may contain letters, numbers, spaces and underscore.",
                form
            });
        }

        if (!phone) {
            return res.status(400).render("auth/signup", {
                error: "Enter a valid 10-digit Indian phone number.",
                form
            });
        }

        if (!validPassword(password)) {
            return res.status(400).render("auth/signup", {
                error: "Password must be at least 6 characters.",
                form
            });
        }

        if (password !== confirmPassword) {
            return res.status(400).render("auth/signup", {
                error: "Password and Confirm Password do not match.",
                form
            });
        }

        const existingPhone = await db.collection("users").findOne({ phone });
        if (existingPhone) {
            return res.status(400).render("auth/signup", {
                error: "This phone number is already registered. Please login.",
                form
            });
        }

        const existingUsername = await db.collection("users").findOne({ usernameKey });
        if (existingUsername) {
            return res.status(400).render("auth/signup", {
                error: "This username is already taken. Please choose another.",
                form
            });
        }

        // Store pending user registration securely in session and metadata
        const pendingUser = {
            username,
            usernameKey,
            name: username,
            phone,
            password: hashPassword(password),
            createdAt: new Date()
        };

        // Dispatch OTP via MSG91 SMS Gateway
        const otpResult = await createAndSendOtp({
            db,
            phone,
            purpose: "registration",
            metadata: pendingUser
        });

        if (!otpResult.success) {
            return res.status(400).render("auth/signup", {
                error: otpResult.message || "Failed to send mobile verification SMS. Please try again.",
                form
            });
        }

        req.session.pendingOtpPhone = phone;
        req.session.pendingOtpPurpose = "registration";
        req.session.pendingOtpUser = pendingUser;

        return res.redirect(`/auth/verify-otp?phone=${phone}&purpose=registration`);
    } catch (error) {
        console.error("Signup Error:", error);
        return res.status(500).render("auth/signup", {
            error: "Unable to process registration. Please try again.",
            form: {
                username: safeText(req.body.username),
                phone: safeText(req.body.phone)
            }
        });
    }
});

// ==========================================
// OTP VERIFICATION & RESEND ENDPOINTS
// ==========================================

router.get("/verify-otp", (req, res) => {
    const phone = normalizePhone(req.query.phone || req.session.pendingOtpPhone);
    const purpose = req.query.purpose || req.session.pendingOtpPurpose || "registration";

    if (!phone) {
        return res.redirect("/auth/signup");
    }

    let message = null;
    if (req.query.msg === "resent") {
        message = "A new verification code was sent via SMS to your mobile.";
    }

    res.render("auth/verify-otp", {
        phone,
        purpose,
        error: null,
        message,
        cooldownSeconds: 60
    });
});

router.post("/verify-otp", async (req, res) => {
    try {
        const db = getDB();
        const phone = normalizePhone(req.body.phone || req.session.pendingOtpPhone);
        const otp = safeText(req.body.otp);
        const purpose = req.body.purpose || req.session.pendingOtpPurpose || "registration";

        if (!phone) {
            return res.redirect("/auth/signup");
        }

        const verifyResult = await verifyOtp({
            db,
            phone,
            otp,
            purpose
        });

        if (!verifyResult.success) {
            return res.status(400).render("auth/verify-otp", {
                phone,
                purpose,
                error: verifyResult.message || "Invalid OTP code",
                message: null,
                cooldownSeconds: 0
            });
        }

        // Case 1: Customer Registration OTP verified
        if (purpose === "registration") {
            const pendingUser = verifyResult.metadata?.username
                ? verifyResult.metadata
                : req.session.pendingOtpUser;

            if (!pendingUser || !pendingUser.username) {
                return res.redirect("/auth/signup");
            }

            // Guard against duplicate user insert
            const exists = await db.collection("users").findOne({
                $or: [{ phone }, { usernameKey: pendingUser.usernameKey }]
            });

            let insertedUserId;
            if (!exists) {
                const insertResult = await db.collection("users").insertOne({
                    username: pendingUser.username,
                    usernameKey: pendingUser.usernameKey,
                    name: pendingUser.name || pendingUser.username,
                    phone: pendingUser.phone,
                    password: pendingUser.password,
                    phoneVerified: true,
                    phoneVerifiedAt: new Date(),
                    cartItems: [],
                    wishlist: [],
                    createdAt: new Date()
                });
                insertedUserId = insertResult.insertedId;

                // Send email notification to Admin for new registration (non-blocking)
                sendNewCustomerRegistrationAdminEmail({
                    user: {
                        username: pendingUser.username,
                        phone: pendingUser.phone,
                        createdAt: new Date()
                    }
                }).catch(err => console.error("Admin registration email error:", err));
            } else {
                insertedUserId = exists._id;
            }

            // Cleanup pending session
            delete req.session.pendingOtpPhone;
            delete req.session.pendingOtpPurpose;
            delete req.session.pendingOtpUser;

            return res.redirect("/auth/login?msg=signup-success");
        }

        // Case 2: Forgot Password OTP verified
        if (purpose === "forgot_password") {
            req.session.passwordResetPhone = phone;
            req.session.passwordResetVerified = true;
            delete req.session.pendingOtpPhone;
            delete req.session.pendingOtpPurpose;
            return res.redirect("/auth/reset-password");
        }

        // Case 3: Phone Number Change OTP verified
        if (purpose === "phone_change") {
            const newPhone = verifyResult.metadata?.newPhone || phone;
            const currentUserId = req.session.userID;

            if (currentUserId && ObjectId.isValid(currentUserId)) {
                await db.collection("users").updateOne(
                    { _id: new ObjectId(currentUserId) },
                    {
                        $set: {
                            phone: newPhone,
                            phoneVerified: true,
                            phoneVerifiedAt: new Date()
                        }
                    }
                );
            }

            delete req.session.pendingOtpPhone;
            delete req.session.pendingOtpPurpose;
            return res.redirect("/address?msg=phone-updated");
        }

        return res.redirect("/auth/login");
    } catch (error) {
        console.error("Verify OTP Error:", error);
        return res.status(500).render("auth/verify-otp", {
            phone: normalizePhone(req.body.phone) || "",
            purpose: req.body.purpose || "registration",
            error: "Unable to verify OTP right now. Please try again.",
            message: null,
            cooldownSeconds: 0
        });
    }
});

router.post("/resend-otp", async (req, res) => {
    try {
        const db = getDB();
        const phone = normalizePhone(req.body.phone || req.session.pendingOtpPhone);
        const purpose = req.body.purpose || req.session.pendingOtpPurpose || "registration";

        if (!phone) {
            return res.redirect("/auth/signup");
        }

        const result = await createAndSendOtp({
            db,
            phone,
            purpose,
            metadata: req.session.pendingOtpUser || {}
        });

        if (!result.success) {
            return res.status(400).render("auth/verify-otp", {
                phone,
                purpose,
                error: result.message,
                message: null,
                cooldownSeconds: result.cooldownSeconds || 0
            });
        }

        return res.redirect(`/auth/verify-otp?phone=${phone}&purpose=${purpose}&msg=resent`);
    } catch (error) {
        console.error("Resend OTP Error:", error);
        return res.status(500).render("auth/verify-otp", {
            phone: normalizePhone(req.body.phone) || "",
            purpose: req.body.purpose || "registration",
            error: "Failed to resend SMS OTP. Please try again.",
            message: null,
            cooldownSeconds: 0
        });
    }
});

// ==========================================
// LOGIN & PASSWORD RECOVERY FLOW
// ==========================================

router.get("/login", (req, res) => {
    if (req.session.userID) return res.redirect("/");

    let message = null;
    if (req.query.msg === "signup-success") {
        message = "Account created and mobile verified successfully! Please login.";
    } else if (req.query.msg === "password-reset") {
        message = "Password reset successfully. Please login with your new password.";
    }

    renderLogin(res, null, message);
});

router.post("/login", async (req, res) => {
    try {
        const db = getDB();
        const loginValue = safeText(req.body.phone);
        const password = String(req.body.password || "");

        if (!loginValue || !password) {
            return renderLogin(res, "Phone number and password are required.");
        }

        const phone = normalizePhone(loginValue);

        const query = phone
            ? { phone }
            : { email: loginValue.toLowerCase() };

        const user = await db.collection("users").findOne(query);

        if (!user || !verifyPassword(password, user.password)) {
            return renderLogin(res, "Invalid phone number or password.");
        }

        // Upgrade legacy plaintext passwords after successful login.
        if (!String(user.password || "").startsWith("scrypt$")) {
            await db.collection("users").updateOne(
                { _id: user._id },
                { $set: { password: hashPassword(password) } }
            );
        }

        req.session.regenerate((err) => {
            if (err) {
                console.error("User session regenerate error:", err);
                return res.status(500).send("Login Session Error");
            }

            req.session.userID = user._id.toString();
            req.session.userName = user.username || user.name || "Account";
            req.session.cartCount = Array.isArray(user.cartItems)
                ? user.cartItems.reduce((sum, item) => sum + Number(item.qty || 0), 0)
                : 0;
            req.session.wishlistCount = Array.isArray(user.wishlist)
                ? user.wishlist.length
                : 0;

            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error("User session save error:", saveErr);
                    return res.status(500).send("Login Session Error");
                }

                res.redirect("/");
            });
        });
    } catch (error) {
        console.error("Login Error:", error);
        return renderLogin(res, "Unable to login right now. Please try again.");
    }
});

router.get("/forgot-password", (req, res) => {
    res.render("auth/forgot-password", {
        error: null,
        message: null,
        phone: ""
    });
});

router.post("/forgot-password", async (req, res) => {
    try {
        const db = getDB();
        const phoneInput = safeText(req.body.phone);
        const phone = normalizePhone(phoneInput);

        if (!phone) {
            return res.status(400).render("auth/forgot-password", {
                error: "Enter a valid 10-digit Indian phone number.",
                message: null,
                phone: phoneInput
            });
        }

        const user = await db.collection("users").findOne({ phone });

        if (!user) {
            return res.status(400).render("auth/forgot-password", {
                error: "No account was found with this phone number.",
                message: null,
                phone: phoneInput
            });
        }

        // Send OTP via MSG91 SMS for password reset
        const otpResult = await createAndSendOtp({
            db,
            phone,
            purpose: "forgot_password"
        });

        if (!otpResult.success) {
            return res.status(400).render("auth/forgot-password", {
                error: otpResult.message || "Unable to send SMS OTP. Please try again.",
                message: null,
                phone: phoneInput
            });
        }

        req.session.pendingOtpPhone = phone;
        req.session.pendingOtpPurpose = "forgot_password";

        return res.redirect(`/auth/verify-otp?phone=${phone}&purpose=forgot_password`);
    } catch (error) {
        console.error("Forgot Password Error:", error);
        return res.status(500).render("auth/forgot-password", {
            error: "Unable to process your request. Please try again.",
            message: null,
            phone: safeText(req.body.phone)
        });
    }
});

router.get("/reset-password", (req, res) => {
    const phone = normalizePhone(req.session.passwordResetPhone);
    const verified = req.session.passwordResetVerified;

    if (!phone || !verified) {
        return res.redirect("/auth/forgot-password");
    }

    res.render("auth/reset-password", {
        error: null,
        phone
    });
});

router.post("/reset-password", async (req, res) => {
    try {
        const db = getDB();
        const phone = normalizePhone(req.session.passwordResetPhone);
        const verified = req.session.passwordResetVerified;
        const password = String(req.body.password || "");
        const confirmPassword = String(req.body.confirmPassword || "");

        if (!phone || !verified) {
            return res.redirect("/auth/forgot-password");
        }

        if (!validPassword(password)) {
            return res.status(400).render("auth/reset-password", {
                error: "Password must be at least 6 characters.",
                phone
            });
        }

        if (password !== confirmPassword) {
            return res.status(400).render("auth/reset-password", {
                error: "Password and Confirm Password do not match.",
                phone
            });
        }

        const user = await db.collection("users").findOne({ phone });

        if (!user) {
            delete req.session.passwordResetPhone;
            delete req.session.passwordResetVerified;
            return res.redirect("/auth/forgot-password");
        }

        await db.collection("users").updateOne(
            { _id: user._id },
            {
                $set: {
                    password: hashPassword(password),
                    updatedAt: new Date()
                }
            }
        );

        delete req.session.passwordResetPhone;
        delete req.session.passwordResetVerified;

        return res.redirect("/auth/login?msg=password-reset");
    } catch (error) {
        console.error("Reset Password Error:", error);
        return res.status(500).render("auth/reset-password", {
            error: "Unable to reset password. Please try again.",
            phone: normalizePhone(req.session.passwordResetPhone) || ""
        });
    }
});

// ==========================================
// PHONE NUMBER CHANGE VERIFICATION FLOW
// ==========================================

router.post("/change-phone/request", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.status(401).json({ ok: false, message: "Please login first" });
        }

        const newPhone = normalizePhone(req.body.newPhone);
        if (!newPhone) {
            return res.status(400).json({ ok: false, message: "Enter a valid 10-digit Indian phone number" });
        }

        const db = getDB();
        const existing = await db.collection("users").findOne({ phone: newPhone });
        if (existing) {
            return res.status(400).json({ ok: false, message: "This phone number is already in use by another account" });
        }

        // Send OTP via MSG91 SMS to the NEW phone number
        const otpResult = await createAndSendOtp({
            db,
            phone: newPhone,
            purpose: "phone_change",
            metadata: {
                userId: req.session.userID,
                newPhone
            }
        });

        if (!otpResult.success) {
            return res.status(400).json({ ok: false, message: otpResult.message });
        }

        req.session.pendingOtpPhone = newPhone;
        req.session.pendingOtpPurpose = "phone_change";

        return res.json({
            ok: true,
            message: `OTP sent via SMS to new mobile number +91-${newPhone}`,
            newPhone
        });
    } catch (error) {
        console.error("Change Phone Request Error:", error);
        return res.status(500).json({ ok: false, message: "Failed to request phone change OTP" });
    }
});

router.post("/change-phone/verify", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.status(401).json({ ok: false, message: "Please login first" });
        }

        const newPhone = normalizePhone(req.body.newPhone || req.session.pendingOtpPhone);
        const otp = safeText(req.body.otp);

        if (!newPhone || !otp) {
            return res.status(400).json({ ok: false, message: "Phone number and OTP are required" });
        }

        const db = getDB();
        const verifyResult = await verifyOtp({
            db,
            phone: newPhone,
            otp,
            purpose: "phone_change"
        });

        if (!verifyResult.success) {
            return res.status(400).json({ ok: false, message: verifyResult.message });
        }

        await db.collection("users").updateOne(
            { _id: new ObjectId(req.session.userID) },
            {
                $set: {
                    phone: newPhone,
                    phoneVerified: true,
                    phoneVerifiedAt: new Date()
                }
            }
        );

        delete req.session.pendingOtpPhone;
        delete req.session.pendingOtpPurpose;

        return res.json({
            ok: true,
            message: `Phone number successfully updated and verified to +91-${newPhone}`
        });
    } catch (error) {
        console.error("Change Phone Verify Error:", error);
        return res.status(500).json({ ok: false, message: "Failed to verify phone change" });
    }
});

router.get("/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) console.error("Logout Error:", err);
        res.clearCookie("connect.sid");
        res.redirect("/");
    });
});

module.exports = router;
