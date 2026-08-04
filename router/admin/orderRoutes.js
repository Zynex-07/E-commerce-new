const express = require("express");
const router = express.Router();

const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");
const { openDelimiter } = require("ejs");

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
        const db = getDB();
        await db.collection("orders").updateOne(
            {
                _id: new ObjectId(req.params.id)
            },
            {
                $set: {
                    status: req.body.status
                }
            }
        );
        res.redirect("/admin/order/view/" + req.params.id);
    } catch (error) {
        console.log(error);
        res.send("Status Update Error");
    }
});

router.get("/delivered/:id", async (req, res) => {
    try {
        const db = getDB();
        await db.collection("orders").updateOne(
            {
                _id: new ObjectId(req.params.id)
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

router.get("/cancel/:id", async (req, res) => {
    try {
        const db = getDB();
        const order = await db.collection("orders").findOne({
            _id: new ObjectId(req.params.id)
        });
        if (!order) {
            return res.send("Order Not Found");
        }
        if (order.status === "Cancelled") {
            return res.redirect("/admin/order");
        }
        for (const item of order.products) {

            await db.collection("product").updateOne(
                {
                    _id: new ObjectId(item.productID)
                },
                {
                    $inc: {
                        stock: item.qty
                    }
                }
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
        res.redirect("/admin/order");
    } catch (error) {
        console.log(error);
        res.send("Cancel Order Error");
    }
});

module.exports = router;