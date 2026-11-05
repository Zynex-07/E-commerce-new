const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");

const MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

const TZ = "+05:30";

function getCurrentMonthRange() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "numeric"
    });
    const parts = formatter.formatToParts(now);
    const year = Number(parts.find(p => p.type === "year")?.value || now.getFullYear());
    const month = Number(parts.find(p => p.type === "month")?.value || (now.getMonth() + 1));

    const start = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00+05:30`);
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const end = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+05:30`);

    return { start, end, year, month };
}

function buildLast12Months(currentYear, currentMonth) {
    const months = [];
    for (let i = 11; i >= 0; i--) {
        let y = currentYear;
        let m = currentMonth - i;
        while (m <= 0) {
            m += 12;
            y -= 1;
        }
        const key = `${y}-${String(m).padStart(2, "0")}`;
        const label = `${MONTH_NAMES[m - 1]} ${y}`;
        months.push({ key, label, year: y, month: m });
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
            recentOrders,
            pendingApprovalOrders
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
            orders.find().sort({ createdAt: -1 }).limit(8).toArray(),
            orders.countDocuments({ cancellationStatus: "Pending Approval" })
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

        const orderMap = Object.fromEntries(orderHistory.map(item => [item._id, item.total]));
        const productMap = Object.fromEntries(productHistory.map(item => [item._id, item.total]));
        const categoryMap = Object.fromEntries(categoryHistory.map(item => [item._id, item.total]));
        const revenueMap = Object.fromEntries(revenueHistory.map(item => [item._id, item.total]));

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
            pendingApprovalOrders,
            monthlyHistory,
            currentMonthLabel: new Date(start).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: TZ })
        });
    } catch (error) {
        console.error("Dashboard error:", error);
        res.status(500).send("Dashboard Fetch Error");
    }
});

module.exports = router;
