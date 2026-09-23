const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

router.get("/", async (req, res) => {
    try {
        const db = getDB();
        const product = await db
            .collection("product")
            .find()
            .toArray();
        res.render("admin/product/index", {
            product
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
        await db.collection("product").insertOne({
            name: name,
            price: Number(price),
            description: description,
            stock: Math.max(0, Number(stock) || 0),
            images: (Array.isArray(images) ? images : [images]).filter(img => String(img || "").trim() !== "").map(img => String(img).trim()),
            categoryId: new ObjectId(categoryId),
            bestSeller: bestSeller === "on",
            createdAt: new Date(),
            // Automatically keep a newly added product in "New Stock" for 3 days.
            newUntil: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
        });
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
        let updateData = {
            name: String(name || "").trim(),
            price: Math.max(0, Number(price) || 0),
            description: String(description || "").trim(),
            stock: Math.max(0, Number(stock) || 0),
            images: (Array.isArray(images) ? images : [images]).filter(img => String(img || "").trim() !== "").map(img => String(img).trim()),
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