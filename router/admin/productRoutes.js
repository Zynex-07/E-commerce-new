const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");
const {
    sendProductAddedAdminEmail,
    sendProductUpdatedAdminEmail,
    sendStockLowAdminEmail,
    sendOutOfStockAdminEmail,
    sendBackInStockCustomerEmail
} = require("../../services/emailService");

router.get("/", async (req, res) => {
    try {
        const db = getDB();
        const product = await db
            .collection("product")
            .find()
            .sort({ createdAt: -1 })
            .toArray();
        const category = await db
            .collection("category")
            .find()
            .sort({ name: 1 })
            .toArray();
        const ratingRows = await db.collection("reviews").aggregate([
            { $match: { rating: { $gte: 1, $lte: 5 } } },
            { $group: { _id: "$productID", average: { $avg: "$rating" }, count: { $sum: 1 } } }
        ]).toArray();
        const ratingMap = Object.fromEntries(ratingRows.map(row => [String(row._id), { average: Number(row.average || 0), count: Number(row.count || 0) }]));
        product.forEach(item => {
            item.ratingAverage = ratingMap[String(item._id)]?.average || 0;
            item.ratingCount = ratingMap[String(item._id)]?.count || 0;
        });
        res.render("admin/product/index", {
            product,
            category
        });
    } catch (error) {
        console.log(error);
        res.send("Product Fetch Error");
    }
});

router.get("/add", async (req, res) => {
    try {
        const db = getDB();
        const category = await db
            .collection("category")
            .find()
            .toArray();
        res.render("admin/product/add", {
            category
        });
    } catch (error) {
        console.log(error);
        res.send("Add Page Error");
    }
});

router.post("/add", async (req, res) => {
    try {
        const db = getDB();
        const { name, price, description, categoryId, stock, images, bestSeller } = req.body;
        if (!String(name || "").trim()) return res.status(400).send("Product name is required");
        if (!ObjectId.isValid(categoryId)) {
            return res.send("Invalid Category ID");
        }

        const newStock = Math.max(0, Number(stock) || 0);
        const newPrice = Math.max(0, Number(price) || 0);
        const imageList = (Array.isArray(images) ? images : [images]).filter(img => String(img || "").trim() !== "").map(img => String(img).trim());

        const insertResult = await db.collection("product").insertOne({
            name: String(name).trim(),
            price: newPrice,
            description: String(description || "").trim(),
            stock: newStock,
            images: imageList,
            categoryId: new ObjectId(categoryId),
            bestSeller: bestSeller === "on",
            createdAt: new Date(),
            // Automatically keep a newly added product in "New Stock" for 3 days.
            newUntil: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
        });

        const newProduct = {
            _id: insertResult.insertedId,
            name: String(name).trim(),
            price: newPrice,
            description: String(description || "").trim(),
            stock: newStock,
            images: imageList,
            categoryId: new ObjectId(categoryId)
        };

        // Non-blocking admin email notifications
        sendProductAddedAdminEmail({ product: newProduct }).catch(err => {
            console.error("[Email Notification Error] Product added notification:", err?.message || err);
        });

        if (newStock === 0) {
            sendOutOfStockAdminEmail({ product: newProduct }).catch(err => {
                console.error("[Email Notification Error] Out-of-stock notification:", err?.message || err);
            });
        } else if (newStock <= 5) {
            sendStockLowAdminEmail({ product: newProduct, currentStock: newStock }).catch(err => {
                console.error("[Email Notification Error] Stock low notification:", err?.message || err);
            });
        }

        res.redirect("/admin/product");
    } catch (error) {
        console.log(error);
        res.send("Add Product Error");
    }
});

router.get("/edit/:id", async (req, res) => {
    try {
        const db = getDB();
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
            return res.send("Invalid Product ID");
        }
        const product = await db
            .collection("product")
            .findOne({
                _id: new ObjectId(id)
            });
        const category = await db
            .collection("category")
            .find()
            .toArray();
        res.render("admin/product/edit", {
            product,
            category
        });
    } catch (error) {
        console.log(error);
        res.send("Edit Page Error");
    }
});

router.post("/update/:id", async (req, res) => {
    try {
        const db = getDB();
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
            return res.send("Invalid Product ID");
        }
        const {
            name,
            price,
            description,
            categoryId,
            stock,
            images,
            bestSeller
        } = req.body;
        if (!ObjectId.isValid(categoryId)) {
            return res.send("Invalid Category ID");
        }

        const existingProduct = await db.collection("product").findOne({ _id: new ObjectId(id) });
        if (!existingProduct) {
            return res.status(404).send("Product Not Found");
        }

        const updatedStock = Math.max(0, Number(stock) || 0);
        const updatedPrice = Math.max(0, Number(price) || 0);
        const imageList = (Array.isArray(images) ? images : [images]).filter(img => String(img || "").trim() !== "").map(img => String(img).trim());

        let updateData = {
            name: String(name || "").trim(),
            price: updatedPrice,
            description: String(description || "").trim(),
            stock: updatedStock,
            images: imageList,
            categoryId: new ObjectId(categoryId),
            bestSeller: bestSeller === "on"
        };
        await db.collection("product").updateOne(
            {
                _id: new ObjectId(id)
            },
            {
                $set: updateData
            }
        );

        const updatedProduct = { ...existingProduct, ...updateData, _id: existingProduct._id };

        // Non-blocking admin notification for product update
        sendProductUpdatedAdminEmail({ product: updatedProduct, changes: updateData }).catch(err => {
            console.error("[Email Notification Error] Product updated notification:", err?.message || err);
        });

        // Stock alerts
        if (updatedStock === 0) {
            sendOutOfStockAdminEmail({ product: updatedProduct }).catch(err => {
                console.error("[Email Notification Error] Out-of-stock notification:", err?.message || err);
            });
        } else if (updatedStock <= 5) {
            sendStockLowAdminEmail({ product: updatedProduct, currentStock: updatedStock }).catch(err => {
                console.error("[Email Notification Error] Low stock notification:", err?.message || err);
            });
        }

        // Back-in-stock notification to subscribed customers if restocked from 0
        if (Number(existingProduct.stock || 0) === 0 && updatedStock > 0) {
            db.collection("stockNotifications").find({
                productID: new ObjectId(id),
                notified: { $ne: true }
            }).toArray().then(subscribers => {
                for (const sub of subscribers) {
                    sendBackInStockCustomerEmail({
                        product: updatedProduct,
                        customerEmail: sub.email,
                        customerName: sub.name || "Customer"
                    }).then(() => {
                        return db.collection("stockNotifications").updateOne(
                            { _id: sub._id },
                            { $set: { notified: true, notifiedAt: new Date() } }
                        );
                    }).catch(subErr => {
                        console.error(`[Email Notification Error] Back-in-stock alert for ${sub.email}:`, subErr?.message || subErr);
                    });
                }
            }).catch(subListErr => {
                console.error("[Email Notification Error] Fetching back-in-stock subscribers:", subListErr?.message || subListErr);
            });
        }

        res.redirect("/admin/product");
    } catch (error) {
        console.log(error);
        res.send("Update Product Error");
    }
});

router.get("/delete/:id", async (req, res) => {
    try {
        const db = getDB();
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
            return res.send("Invalid Product ID");
        }
        await db.collection("product").deleteOne({
            _id: new ObjectId(id)
        });
        res.redirect("/admin/product");
    } catch (error) {
        console.log(error);
        res.send("Delete Product Error");
    }
});

router.get("/category/:id", async (req, res) => {
    try {
        const db = getDB();
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
            return res.send("Invalid Category ID");
        }
        const category = await db
            .collection("category")
            .findOne({
                _id: new ObjectId(id)
            });
        // Support legacy string categoryId values as well as ObjectId values.
        const categoryName = String(category?.name || "").trim();
        const categoryFilter = {
            $or: [
                { categoryId: new ObjectId(id) },
                { categoryId: id }
            ]
        };
        if (categoryName) {
            categoryFilter.$or.push({
                categoryId: { $regex: `^${categoryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }
            });
        }

        const product = await db
            .collection("product")
            .find(categoryFilter)
            .toArray();
        res.render("admin/product/category_product", {
            category,
            product
        });
    } catch (error) {
        console.log(error);
        res.send("Category Product Error");
    }
});

module.exports = router;
