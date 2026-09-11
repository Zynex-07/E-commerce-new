const express = require("express");
const crypto = require("crypto");
const https = require("https");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

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
    const cart = Array.isArray(user.cartItems) ? user.cartItems : [];
    if (!cart.length) throw new Error("Your cart is empty");
    if (!user.address?.address) throw new Error("Please add your delivery address first");
    for (const item of cart) {
        const product = await db.collection("product").findOne({ _id: new ObjectId(item.productID) });
        if (!product) throw new Error(`${item.name} is no longer available`);
        if (Number(product.stock) < Number(item.qty)) throw new Error(`${product.name} has only ${product.stock} item(s) left`);
    }
    const total = cart.reduce((sum, item) => sum + Number(item.total || 0), 0);
    return { db, user, cart, total };
}

router.post("/create-order", requireUser, async (req, res) => {
    try {
        const { total } = await getCart(req);
        if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ ok: false, message: "Invalid cart total" });
        const order = await razorpayRequest("/v1/orders", "POST", {
            amount: Math.round(total * 100),
            currency: "INR",
            receipt: `iv_${Date.now()}_${req.session.userID.toString().slice(-6)}`,
            notes: { userID: req.session.userID.toString() }
        });
        res.json({ ok: true, key: process.env.RAZORPAY_KEY_ID, order });
    } catch (error) {
        console.error("Razorpay Create Order Error:", error);
        res.status(400).json({ ok: false, message: error.message });
    }
});

router.post("/verify", requireUser, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ ok: false, message: "Incomplete payment response" });
        const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");
        if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature))) return res.status(400).json({ ok: false, message: "Payment verification failed" });

        const { db, user, cart, total } = await getCart(req);
        const freshProducts = [];
        for (const item of cart) {
            const product = await db.collection("product").findOne({ _id: new ObjectId(item.productID) });
            if (!product || Number(product.stock) < Number(item.qty)) throw new Error(`${item.name} is out of stock`);
            const category = product.categoryId ? await db.collection("category").findOne({ _id: product.categoryId }) : null;
            freshProducts.push({ ...item, category: category?.name || "" });
        }

        const result = await db.collection("orders").insertOne({
            userID: req.session.userID,
            userName: user.name,
            userEmail: user.email,
            shippingAddress: user.address,
            products: freshProducts,
            total,
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: razorpay_payment_id,
            razorpayOrderId: razorpay_order_id,
            createdAt: new Date()
        });

        for (const item of freshProducts) {
            await db.collection("product").updateOne({ _id: new ObjectId(item.productID) }, { $inc: { stock: -Number(item.qty) } });
        }
        await db.collection("users").updateOne({ _id: new ObjectId(req.session.userID) }, { $set: { cartItems: [] } });
        req.session.cartCount = 0;
        res.json({ ok: true, orderId: result.insertedId.toString() });
    } catch (error) {
        console.error("Razorpay Verify/Place Error:", error);
        res.status(400).json({ ok: false, message: error.message });
    }
});

module.exports = router;
