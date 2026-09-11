const express = require("express");
const router = express.Router();

const { getDB } = require("../../config/db");

router.get("/", async (req, res) => {
    const db = getDB();
    const users = await db.collection("users").find().toArray();

    res.render("admin/users/index", {
        users
    });
});

module.exports = router;