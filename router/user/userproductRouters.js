const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

router.get("/", async (req, res) => {
    const db = getDB();
    const product = await db
        .collection("product")
        .find()
        .toArray();
    const category = await db
        .collection("category")
        .find()
        .toArray();
    res.render("user/product/index", {
        product,
        category
    });
});

router.get("/category/:id", async (req, res) => {
    const db = getDB();
    if (!ObjectId.isValid(req.params.id)) {
        return res.send("Invalid Category Id");
    }
    const category = await db
        .collection("category")
        .findOne({
            _id: new ObjectId(req.params.id)
        });

    const product = await db
        .collection("product")
        .find({
            categoryId: new ObjectId(req.params.id)
        })
        .toArray();
    res.render("user/product/category", {
        category,
        product
    });
});

router.get("/:id", async (req, res) => {
    const db = getDB();
    if (!ObjectId.isValid(req.params.id)) {
        return res.send("Invalid Category Id");
    }
    const product = await db
        .collection("product")
        .findOne({
            _id: new ObjectId(req.params.id)
        })
    res.render("user/product/show", {
        product
    });
});

module.exports = router;