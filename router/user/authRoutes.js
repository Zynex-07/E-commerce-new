const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");
const crypto = require("crypto");

function safeText(value) {
    return String(value ?? "").trim();
}

function normalizePhone(value) {
    let phone = safeText(value).replace(/[\s()-]/g, "");

    if (phone.startsWith("+91")) phone = phone.slice(3);
    else if (phone.startsWith("0091")) phone = phone.slice(4);
    else if (phone.startsWith("91") && phone.length === 12) phone = phone.slice(2);

    return /^\d{10}$/.test(phone) ? phone : null;
}

function phoneForSms(phone) {
    return `+91${phone}`;
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

        await db.collection("users").insertOne({
            username,
            usernameKey,
            // Keep name for compatibility with existing navbar, orders and payment code.
            name: username,
            phone,
            password: hashPassword(password),
            cartItems: [],
            wishlist: [],
            createdAt: new Date()
        });

        return res.redirect("/auth/login?msg=signup-success");
    } catch (error) {
        console.error("Signup Error:", error);
        return res.status(500).render("auth/signup", {
            error: "Unable to create your account. Please try again.",
            form: {
                username: safeText(req.body.username),
                phone: safeText(req.body.phone)
            }
        });
    }
});

router.get("/login", (req, res) => {
    if (req.session.userID) return res.redirect("/");

    let message = null;
    if (req.query.msg === "signup-success") {
        message = "Account created successfully. Please login.";
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

        // Phone is the normal login method. Email fallback keeps old accounts
        // usable until their phone number is added to MongoDB.
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

        // Keep the reset phone number only in the current session.
        // No OTP/SMS service is used in this version.
        req.session.passwordResetPhone = phone;

        return res.redirect("/auth/reset-password");
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

    if (!phone) return res.redirect("/auth/forgot-password");

    res.render("auth/reset-password", {
        error: null,
        phone
    });
});

router.post("/reset-password", async (req, res) => {
    try {
        const db = getDB();
        const phone = normalizePhone(req.session.passwordResetPhone);
        const password = String(req.body.password || "");
        const confirmPassword = String(req.body.confirmPassword || "");

        if (!phone) return res.redirect("/auth/forgot-password");

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

        return res.redirect("/auth/login?msg=password-reset");
    } catch (error) {
        console.error("Reset Password Error:", error);
        return res.status(500).render("auth/reset-password", {
            error: "Unable to reset password. Please try again.",
            phone: normalizePhone(req.session.passwordResetPhone) || ""
        });
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
