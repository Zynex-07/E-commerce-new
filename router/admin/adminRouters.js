const express = require("express");
const crypto = require("crypto");

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

module.exports = router;
