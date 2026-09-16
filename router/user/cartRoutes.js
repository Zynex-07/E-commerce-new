const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

function isAjax(req) {
    return req.query.ajax === "1" || req.headers["x-requested-with"] === "XMLHttpRequest";
}

function requireUser(req, res, next) {
    if (!req.session.userID) {
        if (isAjax(req)) return res.status(401).json({ ok: false, message: "Please login first" });
        return res.redirect("/auth/login");
    }
    next();
}

function toId(value) {
    return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

function normalizeCart(cart) {
    return (Array.isArray(cart) ? cart : []).map(item => ({
        ...item,
        qty: Math.max(1, Number(item.qty) || 1),
        price: Number(item.price) || 0,
        total: (Number(item.price) || 0) * Math.max(1, Number(item.qty) || 1),
        images: item.images || "/images/whiteimg.jpg"
    }));
}

router.use(requireUser);

router.get("/add/:id", async (req, res) => {
    try {
        const productId = toId(req.params.id);
        if (!productId) return isAjax(req) ? res.status(400).json({ ok: false, message: "Invalid Product ID" }) : res.status(400).send("Invalid Product ID");

        const db = getDB();
        const product = await db.collection("product").findOne({ _id: productId });
        if (!product) return isAjax(req) ? res.status(404).json({ ok: false, message: "Product Not Found" }) : res.status(404).send("Product Not Found");

        const requestedQty = Math.max(1, parseInt(req.query.qty, 10) || 1);
        const stock = Math.max(0, Number(product.stock) || 0);
        if (stock < 1) return isAjax(req) ? res.status(400).json({ ok: false, message: "Product is out of stock" }) : res.status(400).send("Product is out of stock");

        const userId = toId(req.session.userID);
        if (!userId) return res.status(401).json({ ok: false, message: "Invalid user session" });
        const user = await db.collection("users").findOne({ _id: userId });
        if (!user) return res.status(404).json({ ok: false, message: "User Not Found" });

        const cart = normalizeCart(user.cartItems);
        const index = cart.findIndex(item => item.productID && item.productID.toString() === product._id.toString());
        const currentQty = index >= 0 ? Number(cart[index].qty) : 0;
        const newQty = currentQty + requestedQty;
        if (newQty > stock) {
            const message = `${product.name} has only ${stock} item(s) in stock`;
            return isAjax(req) ? res.status(400).json({ ok: false, message }) : res.status(400).send(message);
        }

        const price = Number(product.price) || 0;
        const image = Array.isArray(product.images) && product.images[0] ? product.images[0] : "/images/whiteimg.jpg";
        if (index >= 0) {
            cart[index] = { ...cart[index], name: product.name, images: image, price, qty: newQty, total: price * newQty };
        } else {
            cart.push({ productID: product._id, name: product.name, images: image, price, qty: requestedQty, total: price * requestedQty, createdAt: new Date() });
        }

        await db.collection("users").updateOne({ _id: userId }, { $set: { cartItems: cart } });
        req.session.cartCount = cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);

        if (isAjax(req)) return res.json({ ok: true, cartCount: req.session.cartCount, message: "Added to cart" });
        res.redirect(req.query.redirect || "/cart");
    } catch (error) {
        console.error("Add To Cart Error:", error);
        if (isAjax(req)) return res.status(500).json({ ok: false, message: "Add To Cart Error" });
        res.status(500).send("Add To Cart Error");
    }
});

router.post("/update/:id", async (req, res) => {
    try {
        const productId = toId(req.params.id);
        if (!productId) return res.status(400).json({ ok: false, message: "Invalid Product ID" });
        const qty = Math.max(1, parseInt(req.body.qty, 10) || 1);
        const db = getDB();
        const userId = toId(req.session.userID);
        const user = await db.collection("users").findOne({ _id: userId });
        const cart = normalizeCart(user?.cartItems);
        const index = cart.findIndex(item => item.productID?.toString() === productId.toString());
        if (index < 0) return res.status(404).json({ ok: false, message: "Item not in cart" });

        const product = await db.collection("product").findOne({ _id: productId });
        if (!product) return res.status(404).json({ ok: false, message: "Product Not Found" });
        const stock = Math.max(0, Number(product.stock) || 0);
        if (qty > stock) return res.status(400).json({ ok: false, message: `Only ${stock} available` });

        cart[index] = {
            ...cart[index],
            name: product.name,
            price: Number(product.price) || 0,
            images: Array.isArray(product.images) && product.images[0] ? product.images[0] : "/images/whiteimg.jpg",
            qty,
            total: (Number(product.price) || 0) * qty
        };
        await db.collection("users").updateOne({ _id: userId }, { $set: { cartItems: cart } });
        req.session.cartCount = cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);
        const grandTotal = cart.reduce((sum, item) => sum + Number(item.total || 0), 0);
        res.json({ ok: true, itemTotal: cart[index].total, grandTotal, cartCount: req.session.cartCount });
    } catch (error) {
        console.error("Cart Update Error:", error);
        res.status(500).json({ ok: false, message: "Cart Update Error" });
    }
});

router.post("/remove/:id", async (req, res) => {
    try {
        const productId = toId(req.params.id);
        if (!productId) return res.status(400).json({ ok: false, message: "Invalid Product ID" });
        const db = getDB();
        const userId = toId(req.session.userID);
        const user = await db.collection("users").findOne({ _id: userId });
        const cart = normalizeCart(user?.cartItems).filter(item => item.productID?.toString() !== productId.toString());
        await db.collection("users").updateOne({ _id: userId }, { $set: { cartItems: cart } });
        req.session.cartCount = cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);
        res.json({ ok: true, cartCount: req.session.cartCount });
    } catch (error) {
        console.error("Remove Cart Error:", error);
        res.status(500).json({ ok: false, message: "Remove Cart Error" });
    }
});

router.get("/", async (req, res) => {
    try {
        const db = getDB();
        const userId = toId(req.session.userID);
        if (!userId) return res.redirect("/auth/login");
        const user = await db.collection("users").findOne({ _id: userId });
        if (!user) return res.status(404).send("User Not Found");
        const cart = normalizeCart(user.cartItems);
        const grandTotal = cart.reduce((sum, item) => sum + Number(item.total || 0), 0);
        req.session.cartCount = cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);
        res.render("user/cart/index", { cart, grandTotal });
    } catch (error) {
        console.error("Cart Fetch Error:", error);
        res.status(500).send("Cart Fetch Error");
    }
});

router.get("/clear", async (req, res) => {
    try {
        const db = getDB();
        await db.collection("users").updateOne({ _id: toId(req.session.userID) }, { $set: { cartItems: [] } });
        req.session.cartCount = 0;
        res.redirect("/cart");
    } catch (error) {
        console.error("Clear Cart Error:", error);
        res.status(500).send("Clear Cart Error");
    }
});

module.exports = router;
