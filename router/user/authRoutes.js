const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

function safeText(value) {
    return String(value || "").trim();
}

router.get("/signup", (req, res) => {
    res.render("auth/signup", { error: null });
});

router.post("/signup", async (req, res) => {
    try {
        const db = getDB();
        const name = safeText(req.body.name);
        const email = safeText(req.body.email).toLowerCase();
        const password = String(req.body.password || "");

        if (!name || !email || !password) {
            return res.status(400).render("auth/signup", { error: "All fields are required." });
        }
        if (password.length < 6) {
            return res.status(400).render("auth/signup", { error: "Password must be at least 6 characters." });
        }

        const existing = await db.collection("users").findOne({ email });
        if (existing) {
            return res.redirect("/auth/login?msg=email-exists");
        }

        await db.collection("users").insertOne({
            name,
            email,
            password,
            cartItems: [],
            wishlist: [],
            createdAt: new Date()
        });

        res.redirect("/auth/login?msg=signup-success");
    } catch (error) {
        console.error("Signup Error:", error);
        res.status(500).send("Signup Error");
    }
});

router.get("/login", (req, res) => {
    if (req.session.userID) return res.redirect("/");
    res.render("auth/login", { msg: req.query.msg });
});

router.post("/login", async (req, res) => {
    try {
        const db = getDB();
        const email = safeText(req.body.email).toLowerCase();
        const password = String(req.body.password || "");
        if (!email || !password) return res.status(400).send("All Fields Required");

        const user = await db.collection("users").findOne({ email });
        if (!user) return res.status(401).send("Invalid Email or Password");
        if (user.password !== password) return res.status(401).send("Invalid Email or Password");

        req.session.regenerate(async (err) => {
            if (err) {
                console.error("User session regenerate error:", err);
                return res.status(500).send("Login Session Error");
            }

            req.session.userID = user._id.toString();
            req.session.userName = user.name;
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
        res.status(500).send("Login Error");
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
