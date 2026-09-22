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
    const reviews = await db.collection("reviews")
        .find({ productID: product._id, rating: { $gte: 1, $lte: 5 } })
        .sort({ createdAt: -1 }).limit(20).toArray();
    const ratingSummary = reviews.length
        ? { average: reviews.reduce((sum, item) => sum + Number(item.rating), 0) / reviews.length, count: reviews.length }
        : { average: 0, count: 0 };
    res.render("user/product/show", {
        product,
        relatedProducts,
        reviews,
        ratingSummary
    });
});

router.get("/:id/review", async (req, res) => {
    try {
        if (!req.session.userID) return res.redirect("/auth/login");
        if (!ObjectId.isValid(req.params.id)) return res.status(400).send("Invalid Product ID");

        const db = getDB();
        const product = await db.collection("product").findOne({ _id: new ObjectId(req.params.id) });
        if (!product) return res.status(404).send("Product Not Found");

        // Keep the review entry point simple: open the product's review section.
        // The POST endpoint performs the real purchase/delivery verification.
        return res.redirect(`/product/${product._id}#customer-reviews`);
    } catch (error) {
        console.error("Review Page Error:", error);
        return res.status(500).send("Unable to open review page");
    }
});

router.post("/:id/review", async (req, res) => {
    try {
        if (!req.session.userID) return res.redirect("/auth/login");
        if (!ObjectId.isValid(req.params.id)) return res.status(400).send("Invalid Product ID");
        const rating = Number(req.body.rating);
        const comment = String(req.body.comment || "").trim();
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).send("Rating must be between 1 and 5");
        if (!comment) return res.status(400).send("Please write a review");
        const db = getDB();
        const product = await db.collection("product").findOne({ _id: new ObjectId(req.params.id) });
        if (!product) return res.status(404).send("Product Not Found");
        const currentUserId = new ObjectId(req.session.userID);
        const user = await db.collection("users").findOne({ _id: currentUserId });

        // Reviews are only allowed for customers who actually received this product.
        const deliveredOrders = await db.collection("orders").find({
            userID: req.session.userID,
            status: "Delivered",
            products: { $exists: true, $ne: [] }
        }).toArray();
        const hasPurchasedAndReceived = deliveredOrders.some(order =>
            (Array.isArray(order.products) ? order.products : []).some(item =>
                String(item.productID) === String(product._id)
            )
        );
        if (!hasPurchasedAndReceived) {
            return res.status(403).send("You can review this product only after it has been delivered to you.");
        }

        // One review per customer per product.
        const existingReview = await db.collection("reviews").findOne({
            productID: product._id,
            userID: currentUserId
        });
        if (existingReview) {
            return res.redirect(`/product/${product._id}#customer-reviews`);
        }

        await db.collection("reviews").insertOne({
            productID: product._id,
            userID: currentUserId,
            userName: user?.name || req.session.userName || "Customer",
            rating,
            comment,
            createdAt: new Date()
        });
        res.redirect(`/product/${product._id}#customer-reviews`);
    } catch (error) {
        console.error("Review Error:", error);
        res.status(500).send("Unable to submit review");
    }
});

module.exports = router;