const express = require("express");
const router = express.Router();

const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");
const {
    approveCancellationAndRefund,
    rejectCancellationRequest,
    adminDirectCancelOrder,
    reconcileOrderRefund,
    isApiRequest
} = require("../../services/orderService");
const {
    sendOrderStatusUpdateCustomerEmail,
    sendOrderShippedCustomerEmail,
    sendOrderDeliveredCustomerEmail
} = require("../../services/emailService");

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
                Array.isArray(order.products) &&
                order.products.some(product => product.category === category)
            );
        }

        if (status) {
            if (status === "Pending Approval" || status === "cancellation_requests") {
                orders = orders.filter(order => order.cancellationStatus === "Pending Approval");
            } else {
                orders = orders.filter(order => order.status === status);
            }
        }

        const pendingApprovalCount = await db.collection("orders").countDocuments({
            cancellationStatus: "Pending Approval"
        });

        res.render("admin/orders/index", {
            orders,
            category,
            status,
            pendingApprovalCount
        });
    } catch (error) {
        console.error("Order Fetch Error:", error);
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
        console.error("View Order Error:", error);
        res.send("View Order Error");
    }
});

/**
 * Admin approves customer's cancellation request -> initiates FULL Razorpay refund.
 */
router.post("/approve-cancellation/:id", async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            if (isApiRequest(req)) return res.status(400).json({ ok: false, message: "Invalid Order ID" });
            return res.status(400).send("Invalid Order ID");
        }

        const db = getDB();
        const result = await approveCancellationAndRefund({
            db,
            orderId: req.params.id,
            adminUser: req.session?.adminUsername || req.session?.adminEmail || "admin"
        });

        if (isApiRequest(req)) {
            return res.status(result.status).json({
                ok: result.success,
                code: result.code,
                message: result.message,
                refund: result.refund
            });
        }

        if (!result.success) {
            return res.status(result.status).send(result.message);
        }

        return res.redirect(`/admin/order/view/${req.params.id}`);
    } catch (error) {
        console.error("Admin Approve Cancellation Error:", error);
        if (isApiRequest(req)) return res.status(500).json({ ok: false, message: "Approval Error" });
        res.status(500).send("Approval Error");
    }
});

/**
 * Admin rejects customer's cancellation request -> order remains active, stock untouched.
 */
router.post("/reject-cancellation/:id", async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            if (isApiRequest(req)) return res.status(400).json({ ok: false, message: "Invalid Order ID" });
            return res.status(400).send("Invalid Order ID");
        }

        const db = getDB();
        const result = await rejectCancellationRequest({
            db,
            orderId: req.params.id,
            adminUser: req.session?.adminUsername || req.session?.adminEmail || "admin",
            reason: req.body?.reason || "Rejected by administrator"
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

        return res.redirect(`/admin/order/view/${req.params.id}`);
    } catch (error) {
        console.error("Admin Reject Cancellation Error:", error);
        if (isApiRequest(req)) return res.status(500).json({ ok: false, message: "Reject Error" });
        res.status(500).send("Reject Error");
    }
});

/**
 * Admin reconciles an uncertain refund attempt with Razorpay.
 */
router.post("/reconcile-refund/:id", async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            if (isApiRequest(req)) return res.status(400).json({ ok: false, message: "Invalid Order ID" });
            return res.status(400).send("Invalid Order ID");
        }

        const db = getDB();
        const result = await reconcileOrderRefund({
            db,
            orderId: req.params.id,
            adminUser: req.session?.adminUsername || req.session?.adminEmail || "admin"
        });

        if (isApiRequest(req)) {
            return res.status(result.status || 200).json(result);
        }

        return res.redirect(`/admin/order/view/${req.params.id}`);
    } catch (error) {
        console.error("Admin Reconcile Refund Error:", error);
        if (isApiRequest(req)) return res.status(500).json({ ok: false, message: "Reconcile Error" });
        res.status(500).send("Reconcile Error");
    }
});

/**
 * Admin status dropdown update handler.
 */
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

        // If transitioning to Cancelled: use admin direct cancel (which refunds paid orders & restores stock safely)
        if (newStatus === "Cancelled") {
            const result = await adminDirectCancelOrder({
                db,
                orderId: req.params.id,
                adminUser: req.session?.adminUsername || req.session?.adminEmail || "admin"
            });

            if (isApiRequest(req)) {
                return res.status(result.status).json({
                    ok: result.success,
                    code: result.code,
                    message: result.message,
                    refund: result.refund
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

        const updatedOrderObj = { ...order, status: newStatus };
        if (newStatus === "Shipped") {
            sendOrderShippedCustomerEmail({
                order: updatedOrderObj,
                customerEmail: order.userEmail || order.shippingAddress?.email,
                customerName: order.userName
            }).catch(e => console.error("Order shipped email error:", e));
        } else if (newStatus === "Delivered") {
            sendOrderDeliveredCustomerEmail({
                order: updatedOrderObj,
                customerEmail: order.userEmail || order.shippingAddress?.email,
                customerName: order.userName
            }).catch(e => console.error("Order delivered email error:", e));
        } else {
            sendOrderStatusUpdateCustomerEmail({
                order: updatedOrderObj,
                newStatus,
                customerEmail: order.userEmail || order.shippingAddress?.email,
                customerName: order.userName
            }).catch(e => console.error("Order status update email error:", e));
        }

        res.redirect("/admin/order/view/" + req.params.id);
    } catch (error) {
        console.error("Status Update Error:", error);
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
        console.error("Delivered Update Error:", error);
        res.send("Delivered Update Error");
    }
});

/**
 * Admin direct cancellation handler:
 * - Paid order: full refund via Razorpay, status Cancelled, stock restored once.
 * - Unpaid order: safe cancellation, stock restored once.
 */
async function handleAdminDirectCancel(req, res) {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            if (isApiRequest(req)) return res.status(400).json({ ok: false, message: "Invalid Order ID" });
            return res.status(400).send("Invalid Order ID");
        }

        const db = getDB();
        const result = await adminDirectCancelOrder({
            db,
            orderId: req.params.id,
            adminUser: req.session?.adminUsername || req.session?.adminEmail || "admin"
        });

        if (isApiRequest(req)) {
            return res.status(result.status).json({
                ok: result.success,
                code: result.code,
                message: result.message,
                refund: result.refund
            });
        }

        if (!result.success && result.status === 404) {
            return res.status(404).send(result.message);
        }

        if (!result.success) {
            return res.status(result.status).send(result.message);
        }

        res.redirect("/admin/order");
    } catch (error) {
        console.error("Admin Cancel Order Error:", error);
        if (isApiRequest(req)) return res.status(500).json({ ok: false, message: "Cancel Order Error" });
        res.send("Cancel Order Error");
    }
}

// Support both GET and POST for admin direct cancel
router.get("/cancel/:id", handleAdminDirectCancel);
router.post("/cancel/:id", handleAdminDirectCancel);

module.exports = router;
