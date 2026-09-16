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

    // Support both the current ObjectId format and older products where
    // categoryId may have been stored as a string (or category name).
    // This prevents one category (e.g. older Men products) from appearing empty.
    const categoryId = req.params.id;
    const categoryName = String(category?.name || "").trim();
    const categoryFilter = {
        $or: [
            { categoryId: new ObjectId(categoryId) },
            { categoryId: categoryId }
        ]
    };

    if (categoryName) {
        categoryFilter.$or.push({
            categoryId: { $regex: `^${categoryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }
        });
    }

    const product = await db
        .collection("product")
        .find(categoryFilter)
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
        });
    if (!product) {
        return res.status(404).send("Product Not Found");
    }
    const relatedProducts = await db
        .collection("product")
        .find({
            categoryId: product.categoryId,
            _id: { $ne: product._id }
        })
        .limit(4)
        .toArray();
    res.render("user/product/show", {
        product,
        relatedProducts
    });
});

module.exports = router;