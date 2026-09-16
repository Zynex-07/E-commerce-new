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

function imageFor(product) {
    return Array.isArray(product?.images) && product.images[0]
        ? product.images[0]
        : "/images/whiteimg.jpg";
}

function normalizeCart(cart) {
    return (Array.isArray(cart) ? cart : []).map(item => {
        const price = Number(item.price) || 0;
        const qty = Math.max(1, Number(item.qty) || 1);
        return {
            ...item,
            qty,
            price,
            total: price * qty,
            images: item.images || "/images/whiteimg.jpg"
        };
    });
}

function cartCount(cart) {
    return cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);
}

router.use(requireUser);

router.get("/add/:id", async (req, res) => {
    try {
        const productId = toId(req.params.id);
        if (!productId) return isAjax(req)
            ? res.status(400).json({ ok: false, message: "Invalid Product ID" })
            : res.status(400).send("Invalid Product ID");

        const db = getDB();
        const product = await db.collection("product").findOne({ _id: productId });
        if (!product) return isAjax(req)
            ? res.status(404).json({ ok: false, message: "Product not found" })
            : res.status(404).send("Product not found");

        const stock = Math.max(0, Number(product.stock) || 0);
        const requestedQty = Math.max(1, parseInt(req.query.qty, 10) || 1);
        if (stock < 1) return isAjax(req)
            ? res.status(400).json({ ok: false, message: "Product is out of stock" })
            : res.status(400).send("Product is out of stock");

        const userId = toId(req.session.userID);
        if (!userId) return res.status(401).json({ ok: false, message: "Invalid user session" });
        const user = await db.collection("users").findOne({ _id: userId });
        if (!user) return res.status(404).json({ ok: false, message: "User not found" });

        const cart = normalizeCart(user.cartItems);
        const index = cart.findIndex(item => item.productID?.toString() === productId.toString());
        const currentQty = index >= 0 ? Number(cart[index].qty) : 0;
        const newQty = currentQty + requestedQty;
        if (newQty > stock) {
            const message = `${product.name} has only ${stock} item(s) in stock`;
            return isAjax(req) ? res.status(400).json({ ok: false, message }) : res.status(400).send(message);
        }

        const price = Number(product.price) || 0;
        const item = {
            productID: product._id,
            name: product.name,
            images: imageFor(product),
            price,
            qty: newQty,
            total: price * newQty
        };

        if (index >= 0) cart[index] = { ...cart[index], ...item };
        else cart.push({ ...item, createdAt: new Date() });

        await db.collection("users").updateOne({ _id: userId }, { $set: { cartItems: cart } });
        req.session.cartCount = cartCount(cart);

        if (isAjax(req)) return res.json({ ok: true, cartCount: req.session.cartCount, message: "Added to cart" });
        res.redirect(req.query.redirect || "/cart");
    } catch (error) {
        console.error("Add To Cart Error:", error);
        if (isAjax(req)) return res.status(500).json({ ok: false, message: "Unable to add item to cart" });
        res.status(500).send("Unable to add item to cart");
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
        if (!user) return res.status(404).json({ ok: false, message: "User not found" });

        const cart = normalizeCart(user.cartItems);
        const index = cart.findIndex(item => item.productID?.toString() === productId.toString());
        if (index < 0) return res.status(404).json({ ok: false, message: "Item not in cart" });

        const product = await db.collection("product").findOne({ _id: productId });
        if (!product) return res.status(404).json({ ok: false, message: "Product not found" });

        const stock = Math.max(0, Number(product.stock) || 0);
        if (stock < 1) return res.status(400).json({ ok: false, message: "Product is out of stock" });
        if (qty > stock) return res.status(400).json({ ok: false, message: `Only ${stock} available` });

        const price = Number(product.price) || 0;
        cart[index] = {
            ...cart[index],
            productID: product._id,
            name: product.name,
            price,
            images: imageFor(product),
            qty,
            total: price * qty
        };

        await db.collection("users").updateOne({ _id: userId }, { $set: { cartItems: cart } });
        req.session.cartCount = cartCount(cart);
        const grandTotal = cart.reduce((sum, item) => sum + Number(item.total || 0), 0);

        res.json({ ok: true, itemTotal: cart[index].total, grandTotal, cartCount: req.session.cartCount });
    } catch (error) {
        console.error("Cart Update Error:", error);
        res.status(500).json({ ok: false, message: "Unable to update cart" });
    }
});

router.post("/remove/:id", async (req, res) => {
    try {
        const productId = toId(req.params.id);
        if (!productId) return res.status(400).json({ ok: false, message: "Invalid Product ID" });

        const db = getDB();
        const userId = toId(req.session.userID);
        const user = await db.collection("users").findOne({ _id: userId });
        if (!user) return res.status(404).json({ ok: false, message: "User not found" });

        const cart = normalizeCart(user.cartItems).filter(item => item.productID?.toString() !== productId.toString());
        await db.collection("users").updateOne({ _id: userId }, { $set: { cartItems: cart } });
        req.session.cartCount = cartCount(cart);
        res.json({ ok: true, cartCount: req.session.cartCount });
    } catch (error) {
        console.error("Remove Cart Error:", error);
        res.status(500).json({ ok: false, message: "Unable to remove item" });
    }
});

router.get("/", async (req, res) => {
    try {
        const db = getDB();
        const userId = toId(req.session.userID);
        if (!userId) return res.redirect("/auth/login");

        const user = await db.collection("users").findOne({ _id: userId });
        if (!user) return res.status(404).send("User not found");

        const cart = normalizeCart(user.cartItems);
        const grandTotal = cart.reduce((sum, item) => sum + Number(item.total || 0), 0);
        req.session.cartCount = cartCount(cart);

        res.render("user/cart/index", {
            cart,
            grandTotal,
            hasAddress: Boolean(user.address?.address)
        });
    } catch (error) {
        console.error("Cart Fetch Error:", error);
        res.status(500).send("Unable to load cart");
    }
});

async function clearCart(req, res) {
    try {
        const db = getDB();
        await db.collection("users").updateOne(
            { _id: toId(req.session.userID) },
            { $set: { cartItems: [] } }
        );
        req.session.cartCount = 0;
        if (isAjax(req)) return res.json({ ok: true, cartCount: 0 });
        res.redirect("/cart");
    } catch (error) {
        console.error("Clear Cart Error:", error);
        if (isAjax(req)) return res.status(500).json({ ok: false, message: "Unable to clear cart" });
        res.status(500).send("Unable to clear cart");
    }
}

router.post("/clear", clearCart);
router.get("/clear", clearCart); // backwards compatibility

module.exports = router;
