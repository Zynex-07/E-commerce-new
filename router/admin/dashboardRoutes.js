const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");

const TZ = "Asia/Kolkata";

function getCurrentMonthRange() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(now);

    const values = {};
    for (const part of parts) values[part.type] = part.value;

    const year = Number(values.year);
    const month = Number(values.month);

    const start = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00+05:30`);
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const end = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+05:30`);

    return { start, end, year, month };
}

function monthKey(year, month) {
    return `${year}-${String(month).padStart(2, "0")}`;
}

function buildLast12Months(currentYear, currentMonth) {
    const months = [];
    for (let i = 11; i >= 0; i--) {
        const date = new Date(Date.UTC(currentYear, currentMonth - 1 - i, 1));
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        months.push({
            key: monthKey(year, month),
            year,
            month,
            label: date.toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })
        });
    }
    return months;
}

router.get("/", async (req, res) => {
    try {
        const db = getDB();
        const orders = db.collection("orders");
        const products = db.collection("product");
        const categories = db.collection("category");

        const { start, end, year, month } = getCurrentMonthRange();
        const currentRange = { createdAt: { $gte: start, $lt: end } };

        const [
            monthlyOrders,
            monthlyProducts,
            monthlyCategories,
            monthlyRevenueData,
            pendingOrders,
            cancelledOrders,
            lowStockProducts,
            recentOrders
        ] = await Promise.all([
            orders.countDocuments(currentRange),
            products.countDocuments(currentRange),
            categories.countDocuments(currentRange),
            orders.aggregate([
                { $match: { ...currentRange, status: "Delivered" } },
                { $group: { _id: null, totalRevenue: { $sum: { $convert: { input: "$total", to: "double", onError: 0, onNull: 0 } } } } }
            ]).toArray(),
            orders.countDocuments({ ...currentRange, status: "Pending" }),
            orders.countDocuments({ ...currentRange, status: "Cancelled" }),
            products.countDocuments({ stock: { $lte: 5 } }),
            orders.find().sort({ createdAt: -1 }).limit(8).toArray()
        ]);

        const monthlyRevenue = monthlyRevenueData[0]?.totalRevenue || 0;
        const months = buildLast12Months(year, month);
        const firstHistoryDate = new Date(`${months[0].year}-${String(months[0].month).padStart(2, "0")}-01T00:00:00+05:30`);

        const [orderHistory, productHistory, categoryHistory, revenueHistory] = await Promise.all([
            orders.aggregate([
                { $match: { createdAt: { $gte: firstHistoryDate, $lt: end } } },
                { $group: {
                    _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: TZ } },
                    total: { $sum: 1 }
                } }
            ]).toArray(),
            products.aggregate([
                { $match: { createdAt: { $gte: firstHistoryDate, $lt: end } } },
                { $group: {
                    _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: TZ } },
                    total: { $sum: 1 }
                } }
            ]).toArray(),
            categories.aggregate([
                { $match: { createdAt: { $gte: firstHistoryDate, $lt: end } } },
                { $group: {
                    _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: TZ } },
                    total: { $sum: 1 }
                } }
            ]).toArray(),
            orders.aggregate([
                { $match: { createdAt: { $gte: firstHistoryDate, $lt: end }, status: "Delivered" } },
                { $group: {
                    _id: { $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: TZ } },
                    total: { $sum: { $convert: { input: "$total", to: "double", onError: 0, onNull: 0 } } }
                } }
            ]).toArray()
        ]);

        const map = (rows) => Object.fromEntries(rows.map(row => [row._id, row.total || 0]));
        const orderMap = map(orderHistory);
        const productMap = map(productHistory);
        const categoryMap = map(categoryHistory);
        const revenueMap = map(revenueHistory);

        const monthlyHistory = months.map(item => ({
            ...item,
            orders: orderMap[item.key] || 0,
            products: productMap[item.key] || 0,
            categories: categoryMap[item.key] || 0,
            revenue: revenueMap[item.key] || 0
        }));

        res.render("admin/dashboard/index", {
            totalOrders: monthlyOrders,
            totalProducts: monthlyProducts,
            totalCategories: monthlyCategories,
            totalRevenue: monthlyRevenue,
            pendingOrders,
            cancelledOrders,
            lowStockProducts,
            recentOrders,
            monthlyHistory,
            currentMonthLabel: new Date(start).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: TZ })
        });
    } catch (error) {
        console.error("Dashboard error:", error);
        res.status(500).send("Dashboard Fetch Error");
    }
});

module.exports = router;
