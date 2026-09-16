const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

function userId(req) {
    return ObjectId.isValid(req.session.userID) ? new ObjectId(req.session.userID) : null;
}

function requireUser(req, res, next) {
    if (!userId(req)) return res.redirect("/auth/login");
    next();
}

// Old direct order endpoint is kept for compatibility, but payment must happen
// through the cart checkout flow so users cannot create unpaid orders.
router.get("/place", requireUser, (req, res) => res.redirect("/cart"));

router.get("/", requireUser, async (req, res) => {
    try {
        const db = getDB();
        const orders = await db.collection("orders")
            .find({ userID: req.session.userID })
            .sort({ createdAt: -1 })
            .toArray();
        res.render("user/order/index", { orders });
    } catch (error) {
        console.error("Order Fetch Error:", error);
        res.status(500).send("Unable to load orders");
    }
});

router.get("/view/:id", requireUser, async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).send("Invalid Order ID");
        const order = await getDB().collection("orders").findOne({
            _id: new ObjectId(req.params.id),
            userID: req.session.userID
        });
        if (!order) return res.status(404).send("Order Not Found");
        res.render("user/view-order", { order });
    } catch (error) {
        console.error("View Order Error:", error);
        res.status(500).send("Unable to load order");
    }
});

async function cancelOrder(req, res) {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).send("Invalid Order ID");
        const db = getDB();
        const orderId = new ObjectId(req.params.id);

        // Only one request can transition an active order to Cancelled.
        const result = await db.collection("orders").updateOne(
            { _id: orderId, userID: req.session.userID, status: { $nin: ["Cancelled", "Delivered"] } },
            { $set: { status: "Cancelled", cancelledAt: new Date() } }
        );
        if (!result.matchedCount) return res.redirect("/order");

        const order = await db.collection("orders").findOne({ _id: orderId, userID: req.session.userID });
        for (const item of (order?.products || [])) {
            if (!ObjectId.isValid(item.productID)) continue;
            await db.collection("product").updateOne(
                { _id: new ObjectId(item.productID) },
                { $inc: { stock: Math.max(0, Number(item.qty) || 0) } }
            );
        }
        res.redirect("/order");
    } catch (error) {
        console.error("Cancel Order Error:", error);
        res.status(500).send("Unable to cancel order");
    }
}

router.post("/cancel/:id", requireUser, cancelOrder);
router.get("/cancel/:id", requireUser, cancelOrder); // compatibility with older links

// Quantity changes are intentionally not allowed after an order is created.
// Users should change quantities in the cart before payment.
router.get("/increase/:orderId/:productId", requireUser, (req, res) => res.redirect(`/order/view/${req.params.orderId}`));
router.get("/decrease/:orderId/:productId", requireUser, (req, res) => res.redirect(`/order/view/${req.params.orderId}`));

module.exports = router;
