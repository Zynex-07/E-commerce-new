const express = require("express");
const router = express.Router();

const { getDB } = require("../../config/db");

router.get("/", async (req, res) => {
    const db = getDB();
    const totalUsers = await db.collection("users").countDocuments();
    const totalProducts = await db.collection("product").countDocuments();
    const totalOrders = await db.collection("orders").countDocuments();
    const pendingOrders = await db.collection("orders").countDocuments({ status: "Pending" });

    const now = new Date();

    const firstDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        1
    );

    const lastDay = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        1
    );

    const revenueData = await db.collection("orders").aggregate([
        {
            $match: {
                status: "Delivered",
                createdAt: {
                    $gte: firstDay,
                    $lt: lastDay
                }
            }
        },
        {
            $group: {
                _id: null,
                totalRevenue: {
                    $sum: "$total"
                }
            }
        }
    ]).toArray();

    const totalRevenue = revenueData.length > 0 ? revenueData[0].totalRevenue : 0;

    res.render(
        "admin/dashboard/index",
        {
            totalUsers,
            totalProducts,
            totalOrders,
            pendingOrders,
            totalRevenue
        }
    );
});

module.exports = router;
