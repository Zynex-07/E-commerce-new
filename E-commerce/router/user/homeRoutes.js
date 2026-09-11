const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");

router.get("/", async (req, res) => {
    const db = getDB();
    const search = req.query.search || "";
    const product = await db
        .collection("product")
        .find({
            name: {
                $regex: search,
                $options: "i"
            }
        })
        .toArray();
    const category = await db
        .collection("category")
        .find()
        .toArray();

    res.render("user/home/index", {
        product,
        category,
        search
    });
});

module.exports = router;
