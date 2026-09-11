const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

router.get("/place", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.redirect("/");
        }
        const db = getDB();
        const user = await db.collection("users").findOne({
            _id: new ObjectId(req.session.userID)
        });
        const cart = user.cartItems || [];
        console.log(cart);
        for (const item of cart) {
            const product = await db.collection("product").findOne({
                _id: new ObjectId(item.productID)
            });
            if (!product) {
                return res.send("Product not Found");
            }
            if (product.stock < item.qty) {
                return res.send(
                    `${product.name} has only ${product.stock} Items left in stock`
                );
            }
        }
        if (cart.length === 0) {
            return res.redirect("/cart");
        }
        if (!user.address || !user.address.address) {
            return res.redirect("/address");
        }
        for (const item of cart) {
            const product = await db.collection("product").findOne({
                _id: new ObjectId(item.productID)
            });

            console.log("PRODUCT =", product);

            if (product) {
                const category = await db.collection("category").findOne({
                    _id: product.categoryId
                });
                console.log("CATRGORY = ", category);

                item.category = category ? category.name : "";

                console.log("ITEM AFTER CATREGORY = ", item);
            }
        }
        let total = 0;
        cart.forEach(item => {
            total += item.total;
        });
        await db.collection("orders").insertOne({
            userID: req.session.userID,
            userName: user.name,
            userEmail: user.email,
            shippingAddress: user.address,
            products: cart,
            total,
            status: "Pending",
            createdAt: new Date()
        });
        for (const item of cart) {
            await db.collection("product").updateOne(
                {
                    _id: new ObjectId(item.productID)
                },
                {
                    $inc: {
                        stock: -item.qty
                    }
                }
            );
        }
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
        res.render("user/product/order");
    } catch (error) {
        console.log(error);
        res.send("Place Order Error");
    }
});

router.get("/", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.redirect("/auth/login");
        }
        const db = getDB();
        const orders = await db.collection("orders")
            .find({
                userID: req.session.userID
            })
            .sort({
                createdAt: -1
            })
            .toArray();
        res.render("user/order/index", {
            orders
        });
    } catch (error) {
        console.log(error);
        res.send("Order Fetch Error");
    }
});

router.get("/view/:id", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.redirect("/auth/login");
        }
        const db = getDB();
        const order = await db.collection("orders").findOne({
            _id: new ObjectId(req.params.id),
            userID: req.session.userID
        });
        if (!order) {
            return res.send("Order Not Found");
        }
        res.render("user/view-order", {
            order
        });
    } catch (error) {
        console.log(error);
        res.send("View Order Error");
    }
});

router.get("/cancel/:id", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.redirect("/auth/login");
        }
        const db = getDB();
        const order = await db.collection("orders").findOne({
            _id: new ObjectId(req.params.id),
            userID: req.session.userID
        });
        if (!order) {
            return res.send("Order Not Found");
        }
        if (order.status === "Cancelled") {
            return res.redirect("/order");
        }
        console.log("Order Products:", order.products);
        for (const item of order.products) {
            const productBefore = await db.collection("product").findOne({
                _id: item.productID
            });
            console.log(
                "Before Stock:",
                productBefore?.name,
                productBefore?.stock
            );
            const result = await db.collection("product").updateOne(
                {
                    _id: item.productID
                },
                {
                    $inc: {
                        stock: Number(item.qty)
                    }
                }
            );
            console.log("Update Result:", result);
            const productAfter = await db.collection("product").findOne({
                _id: item.productID
            });
            console.log(
                "After Stock:",
                productAfter?.name,
                productAfter?.stock
            );
        }
        await db.collection("orders").updateOne(
            {
                _id: new ObjectId(req.params.id)
            },
            {
                $set: {
                    status: "Cancelled"
                }
            }
        );
        console.log("Order Cancelled Successfully");
        res.redirect("/order");
    } catch (error) {
        console.log("Cancel Order Error:", error);
        res.send("Cancel Order Error");
    }
});

router.get("/increase/:orderId/:productId", async (req, res) => {
    try {
        const db = getDB();
        const order = await db.collection("orders").findOne({
            _id: new ObjectId(req.params.orderId),
            userID: req.session.userID
        });
        if (!order) {
            return res.send("Order Not Found");
        }
        if (order.status !== "Pending") {
            return res.redirect("/order/view/" + req.params.orderId);
        }
        for (const product of order.products) {

            if (product.productID.toString() === req.params.productId) {

                const dbProduct = await db.collection("product").findOne({
                    _id: new ObjectId(product.productID)
                });

                if (!dbProduct) {
                    return res.send("Product Not Found");
                }

                if (product.qty >= dbProduct.stock) {
                    return res.send("Out Of Stock");
                }

                product.qty += 1;
                product.total = product.qty * product.price;
            }
        }
        const total = order.products.reduce((sum, item) => {
            return sum + item.total;
        }, 0);
        await db.collection("orders").updateOne(
            {
                _id: new ObjectId(req.params.orderId)
            },
            {
                $set: {
                    products: order.products,
                    total
                }
            }
        );
        res.redirect("/order/view/" + req.params.orderId);
    } catch (error) {
        console.log(error);
        res.send("Increase Quantity Error");
    }
});

router.get("/decrease/:orderId/:productId", async (req, res) => {
    try {
        const db = getDB();
        const order = await db.collection("orders").findOne({
            _id: new ObjectId(req.params.orderId),
            userID: req.session.userID
        });
        if (!order) {
            return res.send("Order Not Found");
        }
        if (order.status !== "Pending") {
            return res.redirect("/order/view/" + req.params.orderId);
        }
        order.products.forEach(product => {
            if (
                product.productID.toString() === req.params.productId &&
                product.qty > 1
            ) {
                product.qty -= 1;
                product.total = product.qty * product.price;
            }
        });
        const total = order.products.reduce((sum, item) => {
            return sum + item.total;
        }, 0);
        await db.collection("orders").updateOne(
            {
                _id: new ObjectId(req.params.orderId)
            },
            {
                $set: {
                    products: order.products,
                    total
                }
            }
        );
        res.redirect("/order/view/" + req.params.orderId);
    } catch (error) {
        console.log(error);
        res.send("Decrease Quantity Error");
    }
});

module.exports = router;