const express = require("express");
const crypto = require("crypto");
const https = require("https");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");
const { processRazorpayWebhook } = require("../../services/orderService");
const {
    sendNewOrderCustomerEmail,
    sendNewOrderAdminEmail,
    sendStockLowAdminEmail,
    sendOutOfStockAdminEmail
} = require("../../services/emailService");

function requireUser(req, res, next) {
    if (!req.session.userID) return res.status(401).json({ ok: false, message: "Please login first" });
    next();
}

function razorpayRequest(path, method, payload) {
    return new Promise((resolve, reject) => {
        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        if (!keyId || !keySecret) return reject(new Error("Razorpay keys are not configured in .env"));
        const body = JSON.stringify(payload);
        const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
        const req = https.request({
            hostname: "api.razorpay.com",
            path,
            method,
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        }, response => {
            let data = "";
            response.on("data", chunk => data += chunk);
            response.on("end", () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { parsed = { error: { description: data } }; }
                if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
                else reject(new Error(parsed?.error?.description || "Razorpay API error"));
            });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

async function getCart(req) {
    const db = getDB();
    const user = await db.collection("users").findOne({ _id: new ObjectId(req.session.userID) });
    if (!user) throw new Error("User Not Found");
    if (!user.address?.address) throw new Error("Please add your delivery address first");

    const sourceCart = Array.isArray(user.cartItems) ? user.cartItems : [];
    if (!sourceCart.length) throw new Error("Your cart is empty");

    const cart = [];
    for (const item of sourceCart) {
        if (!ObjectId.isValid(item.productID)) throw new Error("A cart item has an invalid product ID");
        const product = await db.collection("product").findOne({ _id: new ObjectId(item.productID) });
        if (!product) throw new Error(`${item.name || "A product"} is no longer available`);
        const qty = Math.max(1, Number(item.qty) || 1);
        const stock = Math.max(0, Number(product.stock) || 0);
        if (stock < qty) throw new Error(`${product.name} has only ${stock} item(s) left`);
        const price = Number(product.price) || 0;
        const category = product.categoryId ? await db.collection("category").findOne({ _id: product.categoryId }) : null;
        cart.push({
            productID: product._id,
            name: product.name,
            images: Array.isArray(product.images) && product.images[0] ? product.images[0] : "/images/whiteimg.jpg",
            price,
            qty,
            total: price * qty,
            category: category?.name || ""
        });
    }
    const total = cart.reduce((sum, item) => sum + item.total, 0);
    return { db, user, cart, total };
}

router.post("/create-order", requireUser, async (req, res) => {
    try {
        const { total, user } = await getCart(req);
        if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ ok: false, message: "Invalid cart total" });
        const amountPaise = Math.round(total * 100);
        const order = await razorpayRequest("/v1/orders", "POST", {
            amount: amountPaise,
            currency: "INR",
            receipt: `iv_${Date.now()}_${req.session.userID.toString().slice(-6)}`,
            notes: { userID: req.session.userID.toString() }
        });
        req.session.razorpayOrder = {
            id: order.id,
            amount: amountPaise,
            createdAt: Date.now()
        };
        await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
        res.json({ ok: true, key: process.env.RAZORPAY_KEY_ID, order, user: { name: user.username || user.name || "Customer", email: user.email || "" } });
    } catch (error) {
        console.error("Razorpay Create Order Error:", error);
        res.status(400).json({ ok: false, message: error.message });
    }
});

router.post("/verify", requireUser, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ ok: false, message: "Incomplete payment response" });
        if (!process.env.RAZORPAY_KEY_SECRET) return res.status(500).json({ ok: false, message: "Razorpay is not configured" });
        const pendingPayment = req.session.razorpayOrder;
        if (!pendingPayment || pendingPayment.id !== String(razorpay_order_id)) {
            return res.status(400).json({ ok: false, message: "Invalid or expired payment order" });
        }
        if (Date.now() - Number(pendingPayment.createdAt || 0) > 30 * 60 * 1000) {
            delete req.session.razorpayOrder;
            return res.status(400).json({ ok: false, message: "Payment session expired. Please try again." });
        }
        const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");
        const expectedBuf = Buffer.from(expected, "utf8");
        const receivedBuf = Buffer.from(String(razorpay_signature), "utf8");
        if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
            return res.status(400).json({ ok: false, message: "Payment verification failed" });
        }

        const { db, user, cart, total } = await getCart(req);
        const expectedAmount = Math.round(total * 100);
        if (Number(pendingPayment.amount) !== expectedAmount) {
            return res.status(400).json({ ok: false, message: "Cart changed during payment. Please create a new payment order." });
        }

        // Idempotency: a retry from the browser must not create a second order.
        const existingPayment = await db.collection("orders").findOne({ paymentId: razorpay_payment_id });
        if (existingPayment) {
            return res.json({ ok: true, orderId: existingPayment._id.toString() });
        }

        const reserved = [];
        try {
            for (const item of cart) {
                const stockResult = await db.collection("product").updateOne(
                    { _id: new ObjectId(item.productID), stock: { $gte: Number(item.qty) } },
                    { $inc: { stock: -Number(item.qty) } }
                );
                if (!stockResult.modifiedCount) throw new Error(`${item.name} is out of stock`);
                reserved.push(item);
            }
        } catch (stockError) {
            for (const item of reserved) {
                await db.collection("product").updateOne({ _id: new ObjectId(item.productID) }, { $inc: { stock: Number(item.qty) } });
            }
            throw stockError;
        }

        let result;
        try {
            result = await db.collection("orders").insertOne({
                userID: req.session.userID,
                userName: user.username || user.name || "Customer",
                userEmail: user.email || "",
                shippingAddress: user.address,
                products: cart,
                total,
                status: "Paid",
                paymentMethod: "Razorpay",
                paymentId: razorpay_payment_id,
                razorpayOrderId: razorpay_order_id,
                createdAt: new Date()
            });
        } catch (insertError) {
            // Payment is already verified; restore reserved stock if order persistence fails.
            for (const item of cart) {
                await db.collection("product").updateOne({ _id: new ObjectId(item.productID) }, { $inc: { stock: Number(item.qty) } });
            }
            throw insertError;
        }

        const createdOrder = {
            _id: result.insertedId,
            userID: req.session.userID,
            userName: user.username || user.name || "Customer",
            userEmail: user.email || user.address?.email || "",
            shippingAddress: user.address,
            products: cart,
            total,
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: razorpay_payment_id,
            razorpayOrderId: razorpay_order_id,
            createdAt: new Date()
        };

        // Asynchronously dispatch Customer & Admin Order Confirmation Emails
        sendNewOrderCustomerEmail({
            order: createdOrder,
            customerEmail: user.email || user.address?.email,
            customerName: user.username || user.name
        }).catch(err => console.error("Customer order email error:", err));

        sendNewOrderAdminEmail({
            order: createdOrder
        }).catch(err => console.error("Admin order email error:", err));

        // Check each purchased item's remaining stock for Admin alerts
        for (const item of cart) {
            db.collection("product").findOne({ _id: new ObjectId(item.productID) })
                .then(prod => {
                    if (!prod) return;
                    if (prod.stock === 0) {
                        sendOutOfStockAdminEmail({ product: prod }).catch(e => console.error("Out of stock email error:", e));
                    } else if (prod.stock <= 5) {
                        sendStockLowAdminEmail({ product: prod, currentStock: prod.stock }).catch(e => console.error("Low stock email error:", e));
                    }
                })
                .catch(err => console.error("Stock check email error:", err));
        }

        await db.collection("users").updateOne({ _id: new ObjectId(req.session.userID) }, { $set: { cartItems: [] } });
        req.session.cartCount = 0;
        delete req.session.razorpayOrder;
        await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
        res.json({ ok: true, orderId: result.insertedId.toString() });
    } catch (error) {
        console.error("Razorpay Verify/Place Error:", error);
        res.status(400).json({ ok: false, message: error.message });
    }
});

/**
 * Razorpay Webhook Endpoint: POST /payment/webhook
 * Authenticates X-Razorpay-Signature using dedicated RAZORPAY_WEBHOOK_SECRET and raw request body.
 * Idempotently processes refund.processed and refund.failed events without duplicate stock restoration.
 */
router.post("/webhook", async (req, res) => {
    try {
        const signature = req.headers["x-razorpay-signature"];
        if (!signature) {
            return res.status(400).json({ ok: false, message: "Missing Razorpay webhook signature header" });
        }

        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
        if (!webhookSecret) {
            return res.status(500).json({ ok: false, message: "Webhook secret is not configured" });
        }

        const rawBody = req.rawBody
            ? req.rawBody
            : (typeof req.body === "string" ? Buffer.from(req.body, "utf8") : Buffer.from(JSON.stringify(req.body || {}), "utf8"));

        const expectedSignature = crypto
            .createHmac("sha256", webhookSecret)
            .update(rawBody)
            .digest("hex");

        const expectedBuf = Buffer.from(expectedSignature, "utf8");
        const receivedBuf = Buffer.from(String(signature), "utf8");

        if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
            return res.status(400).json({ ok: false, message: "Invalid webhook signature" });
        }

        let event = req.body;
        if (typeof event !== "object" || event === null) {
            try {
                event = JSON.parse(rawBody.toString("utf8"));
            } catch {
                return res.status(400).json({ ok: false, message: "Invalid JSON in webhook payload" });
            }
        }

        const db = getDB();
        const result = await processRazorpayWebhook({ db, event });
        return res.status(result.status || 200).json(result);
    } catch (err) {
        console.error("Razorpay Webhook Error:", err);
        return res.status(500).json({ ok: false, message: "Webhook handling error" });
    }
});

module.exports = router;
