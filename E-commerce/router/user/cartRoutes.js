const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

router.use((req, res, next) => {
    console.log("CART ROUTE HIT:", req.method, req.originalUrl);
    next();
});

router.get("/add/:id", async (req, res) => {
    console.log("===== ADD TO CART =====");
    console.log("UserID:", req.session.userID);
    console.log("Product ID:", req.params.id);
    console.log("Qty:", req.query.qty);
    try {
        if (!req.session.userID) {
            return res.redirect("/auth/login");
        }

        const productId = req.params.id;
        if (!ObjectId.isValid(productId)) {
            return res.send("Invalid Product ID");
        }
        const db = getDB();
        const qty = parseInt(req.query.qty) || 1;
        const product = await db.collection("product").findOne({
            _id: new ObjectId(req.params.id)
        });
        if (!product) {
            return res.send("Product Not Found");
        }
        const result = await db.collection("users").updateOne(
            {
                _id: new ObjectId(req.session.userID)
            },
            {
                $push: {
                    cartItems: {
                        productID: product._id,
                        name: product.name,
                        images: product.images[0],
                        price: product.price,
                        qty: qty,
                        total: product.price * qty,
                        createdAt: new Date()
                    }
                }
            }
        );
        console.log("Update Result:", result);
        res.redirect("/cart");
    } catch (error) {
        console.log(error);
        res.send("Add To Cart Error");
    }
});

router.get("/", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.redirect("/auth/login");
        }
        const db = getDB();
        const user = await db.collection("users")
            .findOne({
                _id: new ObjectId(req.session.userID)
            });
        if (!user) {
            return res.send("User Not Found");
        }
        const cart = user.cartItems || [];
        let grandTotal = 0;
        cart.forEach(item => {
            grandTotal += item.total;
        });
        res.render("user/cart/index", {
            cart,
            grandTotal
        });
    } catch (error) {
        console.log(error);
        res.send("Cart Fetch Error");
    }
});

router.get("/clear", async (req, res) => {
    try {
        const db = getDB();
        await db.collection("users").updateOne(
            {
                _id: new ObjectId(req.session.userID)
            },
            {
                $set: {
                    cartItems: []
                }
            }
        );
        res.redirect("/cart");
    } catch (error) {
        console.log(error);
        res.send("Clear Cart Error");
    };
});

module.exports = router;
