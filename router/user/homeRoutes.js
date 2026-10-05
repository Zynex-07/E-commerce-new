const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
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

    const now = new Date();
    const newStock = await db
        .collection("product")
        .find({ newUntil: { $gt: now } })
        .sort({ createdAt: -1 })
        .limit(8)
        .toArray();

    // Best sellers are selected manually by the admin.
    const bestSellers = await db
        .collection("product")
        .find({ bestSeller: true })
        .sort({ createdAt: -1 })
        .limit(8)
        .toArray();

    // Homepage customer rating section uses real submitted reviews when available.
    const reviews = await db.collection("reviews").find({ rating: { $gte: 1, $lte: 5 } })
        .sort({ createdAt: -1 }).limit(6).toArray();

    const blogs = [
        {
            title: "The Modern Business-Casual Look",
            text: "A light shirt with clean trousers creates an easy, polished outfit that works for office days, meetings and smart everyday plans.",
            tag: "Men's Style",
            image: "/images/blog-business-casual.jpg"
        },
        {
            title: "Formal & Party Dressing",
            text: "For celebrations and evening events, classic tailoring and elegant statement pieces create a refined occasion-ready look.",
            tag: "Party Wear",
            image: "/images/blog-formal-party.webp"
        },
        {
            title: "Timeless Traditional Style",
            text: "Embroidered details, rich colours and traditional silhouettes bring together an authentic ethnic look for festive occasions.",
            tag: "Ethnic Edit",
            image: "/images/blog-traditional-ethnic.jpg"
        }
    ];

    res.render("user/home/index", {
        product,
        category,
        search,
        newStock,
        bestSellers,
        reviews,
        blogs
    });
});

module.exports = router;
