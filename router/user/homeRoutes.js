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

    // Best sellers are calculated from successful paid/delivered orders.
    const salesOrders = await db.collection("orders")
        .find({ status: { $in: ["Paid", "Delivered"] } }, { projection: { products: 1 } })
        .toArray();
    const salesMap = new Map();
    for (const order of salesOrders) {
        for (const item of (order.products || [])) {
            const key = String(item.productID || "");
            if (!key) continue;
            salesMap.set(key, (salesMap.get(key) || 0) + Math.max(0, Number(item.qty) || 0));
        }
    }
    const bestSellerIds = [...salesMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
    let bestSellers = [];
    if (bestSellerIds.length) {
        const ids = bestSellerIds.map(([id]) => id);
        const candidates = await db.collection("product").find({
            $or: ids.map(id => ({ _id: ObjectId.isValid(id) ? new ObjectId(id) : id }))
        }).toArray();
        const byId = new Map(candidates.map(item => [String(item._id), item]));
        bestSellers = bestSellerIds.map(([id, soldQty]) => {
            const item = byId.get(id);
            return item ? { ...item, soldQty } : null;
        }).filter(Boolean);
    }
    if (!bestSellers.length) {
        bestSellers = product.slice().sort((a, b) => (Number(b.stock) || 0) - (Number(a.stock) || 0)).slice(0, 8);
    }

    // Homepage customer rating section uses real submitted reviews when available.
    const reviews = await db.collection("reviews").find({ rating: { $gte: 1, $lte: 5 } })
        .sort({ createdAt: -1 }).limit(6).toArray();

    const blogs = [
        { title: "How to build an everyday wardrobe", text: "Simple ways to combine versatile pieces and create more outfits with less effort.", tag: "Style Guide", image: "/images/women.jpg" },
        { title: "3 ways to style your new favourite", text: "From casual days to evening plans, make one great piece work harder for you.", tag: "Outfit Ideas", image: "/images/shoes_1.webp" },
        { title: "Choosing the right fit", text: "A quick guide to comfortable silhouettes, proportions and everyday styling.", tag: "Fashion Tips", image: "/images/whiteimg.jpg" }
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
