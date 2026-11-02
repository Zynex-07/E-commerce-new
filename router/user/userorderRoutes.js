const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");
const { cancelOrderSafely, isApiRequest } = require("../../services/orderService");

function userId(req) {
    return ObjectId.isValid(req.session.userID) ? new ObjectId(req.session.userID) : null;
}

function requireUser(req, res, next) {
    if (!userId(req)) {
        if (isApiRequest(req)) {
            return res.status(401).json({ ok: false, message: "Please login first" });
        }
        return res.redirect("/auth/login");
    }
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

        // Build a quick lookup so the Orders page can show a Write Review button
        // only for delivered products that have not already been reviewed.
        const deliveredProductIds = new Set();
        for (const order of orders) {
            if (order.status !== "Delivered") continue;
            for (const item of (Array.isArray(order.products) ? order.products : [])) {
                if (ObjectId.isValid(item.productID)) deliveredProductIds.add(String(item.productID));
            }
        }
        const reviewedProductIds = new Set();
        if (deliveredProductIds.size) {
            const reviews = await db.collection("reviews").find({
                userID: new ObjectId(req.session.userID),
                productID: { $in: Array.from(deliveredProductIds).map(id => new ObjectId(id)) }
            }, { projection: { productID: 1 } }).toArray();
            reviews.forEach(review => reviewedProductIds.add(String(review.productID)));
        }

        res.render("user/order/index", {
            orders,
            reviewedProductIds: Array.from(reviewedProductIds)
        });
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
        if (!ObjectId.isValid(req.params.id)) {
            if (isApiRequest(req)) return res.status(400).json({ ok: false, message: "Invalid Order ID" });
            return res.status(400).send("Invalid Order ID");
        }

        const db = getDB();
        const result = await cancelOrderSafely({
            db,
            orderId: req.params.id,
            userId: req.session.userID,
            allowedStatuses: ["Pending", "Paid"]
        });

        if (isApiRequest(req)) {
            return res.status(result.status).json({
                ok: result.success,
                code: result.code,
                message: result.message
            });
        }

        if (!result.success && result.status === 404) {
            return res.status(404).send(result.message);
        }

        // For regular browser form submissions, redirect back to orders list
        return res.redirect("/order");
    } catch (error) {
        console.error("Cancel Order Error:", error);
        if (isApiRequest(req)) {
            return res.status(500).json({ ok: false, message: "Unable to cancel order" });
        }
        return res.status(500).send("Unable to cancel order");
    }
}

router.post("/cancel/:id", requireUser, cancelOrder);
router.get("/cancel/:id", requireUser, cancelOrder); // compatibility with older links

// Quantity changes are intentionally not allowed after an order is created.
// Users should change quantities in the cart before payment.
router.get("/increase/:orderId/:productId", requireUser, (req, res) => res.redirect(`/order/view/${req.params.orderId}`));
router.get("/decrease/:orderId/:productId", requireUser, (req, res) => res.redirect(`/order/view/${req.params.orderId}`));

module.exports = router;
