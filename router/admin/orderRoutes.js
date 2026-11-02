const express = require("express");
const router = express.Router();

const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");
const { cancelOrderSafely, isApiRequest } = require("../../services/orderService");

router.get("/", async (req, res) => {
    try {
        const db = getDB();
        const category = req.query.category;
        const status = req.query.status;

        let orders = await db.collection("orders")
            .find()
            .sort({ createdAt: -1 })
            .toArray();
        if (category) {
            orders = orders.filter(order =>
                order.products.some(product =>
                    product.category === category
                )
            );
        }
        if (status) {
            orders = orders.filter(order =>
                order.status === status
            );
        }
        res.render("admin/orders/index", {
            orders,
            category,
            status
        });
    } catch (error) {
        console.log(error);
        res.send("Order Fetch Error");
    }
});

router.get("/view/:id", async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            return res.status(400).send("Invalid Order ID");
        }
        const db = getDB();
        const order = await db.collection("orders").findOne({
            _id: new ObjectId(req.params.id)
        });
        if (!order) {
            return res.send("Order Not Found");
        }
        res.render("admin/orders/view", {
            order
        });
    } catch (error) {
        console.log(error);
        res.send("View Order Error");
    }
});

router.post("/status/:id", async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            if (isApiRequest(req)) return res.status(400).json({ ok: false, message: "Invalid Order ID" });
            return res.status(400).send("Invalid Order ID");
        }

        const db = getDB();
        const orderId = new ObjectId(req.params.id);
        const order = await db.collection("orders").findOne({ _id: orderId });
        if (!order) {
            if (isApiRequest(req)) return res.status(404).json({ ok: false, message: "Order Not Found" });
            return res.status(404).send("Order Not Found");
        }

        const newStatus = req.body.status;

        // If the order is already cancelled, prevent re-cancellation or changing status
        if (order.status === "Cancelled") {
            if (newStatus === "Cancelled") {
                return res.redirect("/admin/order/view/" + req.params.id);
            }
            if (isApiRequest(req)) return res.status(400).json({ ok: false, message: "Cannot change status of a cancelled order" });
            return res.status(400).send("Cannot change status of a cancelled order");
        }

        // If transitioning to Cancelled, safely restore stock and update status
        if (newStatus === "Cancelled") {
            const result = await cancelOrderSafely({
                db,
                orderId: req.params.id,
                userId: null,
                allowedStatuses: ["Pending", "Paid", "Processing"]
            });

            if (isApiRequest(req)) {
                return res.status(result.status).json({
                    ok: result.success,
                    code: result.code,
                    message: result.message
                });
            }

            if (!result.success) {
                return res.status(result.status).send(result.message);
            }

            return res.redirect("/admin/order/view/" + req.params.id);
        }

        // Delivered orders cannot transition back to another status
        if (order.status === "Delivered" && newStatus !== "Delivered") {
            if (isApiRequest(req)) return res.status(400).json({ ok: false, message: "Cannot change status of a delivered order" });
            return res.status(400).send("Cannot change status of a delivered order");
        }

        await db.collection("orders").updateOne(
            { _id: orderId },
            { $set: { status: newStatus } }
        );
        res.redirect("/admin/order/view/" + req.params.id);
    } catch (error) {
        console.log(error);
        if (isApiRequest(req)) return res.status(500).json({ ok: false, message: "Status Update Error" });
        res.send("Status Update Error");
    }
});

router.get("/delivered/:id", async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            return res.status(400).send("Invalid Order ID");
        }
        const db = getDB();
        // A cancelled order cannot be delivered
        await db.collection("orders").updateOne(
            {
                _id: new ObjectId(req.params.id),
                status: { $ne: "Cancelled" }
            },
            {
                $set: {
                    status: "Delivered"
                }
            }
        );
        res.redirect("/admin/order");
    } catch (error) {
        console.log(error);
        res.send("Delivered Update Error");
    }
});

async function handleAdminCancel(req, res) {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            if (isApiRequest(req)) return res.status(400).json({ ok: false, message: "Invalid Order ID" });
            return res.status(400).send("Invalid Order ID");
        }

        const db = getDB();
        const result = await cancelOrderSafely({
            db,
            orderId: req.params.id,
            userId: null,
            allowedStatuses: ["Pending", "Paid", "Processing"]
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

        res.redirect("/admin/order");
    } catch (error) {
        console.log(error);
        if (isApiRequest(req)) return res.status(500).json({ ok: false, message: "Cancel Order Error" });
        res.send("Cancel Order Error");
    }
}

// Support both GET (existing links) and direct POST/API requests
router.get("/cancel/:id", handleAdminCancel);
router.post("/cancel/:id", handleAdminCancel);

module.exports = router;
