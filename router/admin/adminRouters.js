const express = require("express");
const crypto = require("crypto");
const { requireAdmin } = require("../../middleware/adminAuth");
const { verifySmtpConnection, sendAdminTestEmail } = require("../../services/emailService");

const router = express.Router();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@2026#Shop";

function safeEqual(a, b) {
    const aBuf = Buffer.from(String(a));
    const bBuf = Buffer.from(String(b));

    if (aBuf.length !== bBuf.length) {
        return false;
    }

    return crypto.timingSafeEqual(aBuf, bBuf);
}

router.get("/login", (req, res) => {
    if (req.session && req.session.admin) {
        return res.redirect("/admin/dashboard");
    }

    res.render("admin/auth/login", {
        error: null,
        username: ""
    });
});

router.post("/login", (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        if (!username || !password) {
            return res.status(400).render("admin/auth/login", {
                error: "Username and password are required.",
                username
            });
        }

        if (!safeEqual(username, ADMIN_USERNAME) || !safeEqual(password, ADMIN_PASSWORD)) {
            return res.status(401).render("admin/auth/login", {
                error: "Invalid admin username or password.",
                username
            });
        }

        req.session.regenerate((err) => {
            if (err) {
                console.error("Admin session error:", err);
                return res.status(500).render("admin/auth/login", {
                    error: "Unable to create secure session. Please try again.",
                    username
                });
            }

            req.session.admin = {
                username: ADMIN_USERNAME,
                name: "Administrator"
            };

            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error("Admin session save error:", saveErr);
                    return res.status(500).render("admin/auth/login", {
                        error: "Unable to save login session. Please try again.",
                        username
                    });
                }

                res.redirect("/admin/dashboard");
            });
        });
    } catch (error) {
        console.error("Admin login error:", error);
        res.status(500).render("admin/auth/login", {
            error: "Something went wrong. Please try again.",
            username: ""
        });
    }
});

router.get("/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("Admin logout error:", err);
        }

        res.clearCookie("connect.sid");
        res.redirect("/admin/login");
    });
});

/**
 * GET /admin/test-email
 * Diagnostic endpoint: verifies Gmail SMTP connectivity and optionally dispatches a test email.
 * Pass ?send=1 or ?send=true to dispatch a test email to ADMIN_EMAIL.
 */
router.get("/test-email", requireAdmin, async (req, res) => {
    try {
        const verifyResult = await verifySmtpConnection();
        if (req.query.send === "1" || req.query.send === "true") {
            if (!verifyResult.ok) {
                return res.status(502).json({
                    ok: false,
                    connection: verifyResult,
                    error: "SMTP connection failed; cannot send test email."
                });
            }

            const sendResult = await sendAdminTestEmail({
                triggeredBy: req.session.admin?.username || "Admin"
            });

            return res.json({
                ok: sendResult.success,
                connection: verifyResult,
                dispatch: sendResult
            });
        }

        return res.json({
            ok: verifyResult.ok,
            connection: verifyResult,
            note: "Add ?send=1 to this URL or send a POST request to dispatch a live test email to ADMIN_EMAIL."
        });
    } catch (err) {
        console.error("Admin Test Email GET Error:", err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /admin/test-email
 * Admin-only endpoint: verifies Gmail SMTP connection and sends a test email to the configured ADMIN_EMAIL.
 */
router.post("/test-email", requireAdmin, async (req, res) => {
    try {
        const verifyResult = await verifySmtpConnection();
        if (!verifyResult.ok) {
            return res.status(502).json({
                ok: false,
                connection: verifyResult,
                error: verifyResult.message || "Gmail SMTP verification failed."
            });
        }

        const sendResult = await sendAdminTestEmail({
            triggeredBy: req.session.admin?.username || "Admin"
        });

        if (!sendResult.success) {
            return res.status(500).json({
                ok: false,
                connection: verifyResult,
                dispatch: sendResult,
                error: sendResult.error || "Failed to dispatch test email."
            });
        }

        return res.json({
            ok: true,
            message: "Test email successfully dispatched to configured ADMIN_EMAIL.",
            connection: verifyResult,
            dispatch: {
                recipient: sendResult.recipient,
                messageId: sendResult.messageId,
                simulated: !!sendResult.simulated,
                timestamp: sendResult.timestamp
            }
        });
    } catch (err) {
        console.error("Admin Test Email POST Error:", err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
