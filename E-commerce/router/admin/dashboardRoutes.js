const express = require("express");
const router = express.Router();

const { getDB } = require("../../config/db");

router.get("/", async (req, res) => {
    try {
        const db = getDB();
        const ordersCollection = db.collection("orders");

        const [
            totalUsers,
            totalProducts,
            totalCategories,
            totalOrders,
            pendingOrders,
            cancelledOrders,
            lowStockProducts
        ] = await Promise.all([
            db.collection("users").countDocuments(),
            db.collection("product").countDocuments(),
            db.collection("category").countDocuments(),
            ordersCollection.countDocuments(),
            ordersCollection.countDocuments({ status: "Pending" }),
            ordersCollection.countDocuments({ status: "Cancelled" }),
            db.collection("product").countDocuments({ stock: { $lte: 5 } })
        ]);

        const revenueData = await ordersCollection.aggregate([
            { $match: { status: "Delivered" } },
            { $group: { _id: null, totalRevenue: { $sum: { $ifNull: ["$total", 0] } } } }
        ]).toArray();

        const totalRevenue = revenueData[0]?.totalRevenue || 0;

        const recentOrders = await ordersCollection
            .find()
            .sort({ createdAt: -1 })
            .limit(8)
            .toArray();

        res.render("admin/dashboard/index", {
            totalUsers,
            totalProducts,
            totalCategories,
            totalOrders,
            pendingOrders,
            cancelledOrders,
            lowStockProducts,
            totalRevenue,
            recentOrders
        });
    } catch (error) {
        console.error("Dashboard error:", error);
        res.status(500).send("Dashboard Fetch Error");
    }
});

module.exports = router;
