const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

function requireUser(req, res, next) {
    if (!req.session.userID) {
        if (req.query.ajax === "1" || req.headers["x-requested-with"] === "XMLHttpRequest") return res.status(401).json({ ok: false, message: "Please login first" });
        return res.redirect("/auth/login");
    }
    next();
}

router.use(requireUser);

router.get("/add/:id", async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).send("Invalid Product ID");
        const db = getDB();
        const product = await db.collection("product").findOne({ _id: new ObjectId(req.params.id) });
        if (!product) return res.status(404).send("Product Not Found");

        const requestedQty = Math.max(1, parseInt(req.query.qty, 10) || 1);
        const stock = Number(product.stock) || 0;
        if (stock < 1) return res.status(400).send("Product is out of stock");

        const userId = new ObjectId(req.session.userID);
        const user = await db.collection("users").findOne({ _id: userId });
        if (!user) return res.status(404).send("User Not Found");

        const cart = Array.isArray(user.cartItems) ? user.cartItems : [];
        const index = cart.findIndex(item => item.productID && item.productID.toString() === product._id.toString());
        const newQty = index >= 0 ? Number(cart[index].qty || 0) + requestedQty : requestedQty;
        if (newQty > stock) return res.status(400).send(`${product.name} has only ${stock} item(s) in stock`);

        if (index >= 0) {
            cart[index].qty = newQty;
            cart[index].price = Number(product.price) || 0;
            cart[index].name = product.name;
            cart[index].images = product.images?.[0] || "/images/whiteimg.jpg";
            cart[index].total = cart[index].price * newQty;
        } else {
            cart.push({
                productID: product._id,
                name: product.name,
                images: product.images?.[0] || "/images/whiteimg.jpg",
                price: Number(product.price) || 0,
                qty: requestedQty,
                total: (Number(product.price) || 0) * requestedQty,
                createdAt: new Date()
            });
        }

        await db.collection("users").updateOne({ _id: userId }, { $set: { cartItems: cart } });
        req.session.cartCount = cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);

        if (req.query.ajax === "1") return res.json({ ok: true, cartCount: req.session.cartCount });
        res.redirect(req.query.redirect || "/cart");
    } catch (error) {
        console.error("Add To Cart Error:", error);
        res.status(500).send("Add To Cart Error");
    }
});

router.post("/update/:id", async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, message: "Invalid Product ID" });
        const qty = Math.max(1, parseInt(req.body.qty, 10) || 1);
        const db = getDB();
        const userId = new ObjectId(req.session.userID);
        const user = await db.collection("users").findOne({ _id: userId });
        const cart = Array.isArray(user?.cartItems) ? user.cartItems : [];
        const index = cart.findIndex(item => item.productID?.toString() === req.params.id);
        if (index < 0) return res.status(404).json({ ok: false, message: "Item not in cart" });

        const product = await db.collection("product").findOne({ _id: new ObjectId(req.params.id) });
        if (!product) return res.status(404).json({ ok: false, message: "Product Not Found" });
        if (qty > Number(product.stock || 0)) return res.status(400).json({ ok: false, message: `Only ${product.stock} available` });

        cart[index].qty = qty;
        cart[index].price = Number(product.price) || 0;
        cart[index].total = cart[index].price * qty;
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
        const db = getDB();
        const userId = new ObjectId(req.session.userID);
        const user = await db.collection("users").findOne({ _id: userId });
        const cart = (user?.cartItems || []).filter(item => item.productID?.toString() !== req.params.id);
        await db.collection("users").updateOne({ _id: userId }, { $set: { cartItems: cart } });
        req.session.cartCount = cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);
        if (req.accepts("json") && req.headers["x-requested-with"] === "XMLHttpRequest") return res.json({ ok: true, cartCount: req.session.cartCount });
        res.redirect("/cart");
    } catch (error) {
        console.error("Remove Cart Error:", error);
        res.status(500).send("Remove Cart Error");
    }
});

router.get("/", async (req, res) => {
    try {
        const db = getDB();
        const user = await db.collection("users").findOne({ _id: new ObjectId(req.session.userID) });
        if (!user) return res.status(404).send("User Not Found");
        const cart = user.cartItems || [];
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
        await db.collection("users").updateOne({ _id: new ObjectId(req.session.userID) }, { $set: { cartItems: [] } });
        req.session.cartCount = 0;
        res.redirect("/cart");
    } catch (error) {
        console.error("Clear Cart Error:", error);
        res.status(500).send("Clear Cart Error");
    }
});

module.exports = router;
