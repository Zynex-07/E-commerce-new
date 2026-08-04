const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");

router.get("/signup", (req, res) => {
    res.render("auth/signup");
});

router.post("/signup", async (req, res) => {
    try {
        const db = getDB();
        const { name, email, password } = req.body;
        const user = await db
            .collection("users")
            .findOne({
                email: email
            });
        if (user) {
            return res.redirect(
                "/auth/login?msg=email-exists"
            );
        }
        await db.collection("users")
            .insertOne({
                name,
                email,
                password,
                createdAt: new Date()
            });
        res.redirect("/auth/login");
    } catch (error) {
        console.log(error);
        res.send("Signup Error");
    }
});

router.get("/login", (req, res) => {
    res.render("auth/login", {
        msg: req.query.msg
    });
});

router.post("/login", async (req, res) => {
    try {
        const db = getDB();
        const { email, password } = req.body;
        if (!email || !password) {
            return res.send("All Fields Required");
        }
        const user = await db
            .collection("users")
            .findOne({
                email: email
            });
        if (!user) {
            return res.send("Invalid Email");
        }
        if (user.password !== password) {
            return res.send("Invalid Password");
        }
        req.session.userID = user._id;
        req.session.userName = user.name;
        res.redirect("/");
    } catch (error) {
        console.log(error);
        res.send("Login Error");
    }
});

router.get("/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.log(err);
            return res.send("Logout Error");
        }
        res.redirect("/auth/login");
    });
});

module.exports = router;
