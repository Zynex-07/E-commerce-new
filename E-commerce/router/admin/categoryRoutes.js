const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { getDB } = require("../../config/db");

router.get("/", async (req, res) => {
    try {
        const db = getDB();
        const category = await db
            .collection("category")
            .find()
            .toArray();
        res.render("admin/category/index", {
            category
        });
    } catch (error) {
        console.log(error);
        res.send("Category Fetch Error");
    }
});

router.get("/add", (req, res) => {
    res.render("admin/category/add");
});

router.post("/add", async (req, res) => {
    try {
        const db = getDB();
        await db.collection("category").insertOne({
            name: req.body.name
        });
        res.redirect("/admin/category");
    } catch (error) {
        console.log("error");
        res.send("Add Category Error");
    }
});


router.get("/edit/:id", async (req, res) => {
    try {
        const db = getDB();
        const category = await db
            .collection("category")
            .findOne({
                _id: new ObjectId(req.params.id)
            });
        res.render("admin/category/edit", {
            category
        });
    } catch (error) {
        console.log(error);
        res.send("Edit Category Error");
    }
});

router.post("/update/:id", async (req, res) => {
    try {
        const db = getDB();
        await db.collection("category").updateOne(
            {
                _id: new ObjectId(req.params.id)
            },
            {
                $set: {
                    name: req.body.name
                }
            }
        );
        res.redirect("/admin/category");
    } catch (error) {
        console.log(error);
        res.send("Upddate Category Error")
    }
});

router.get("/delete/:id", async (req, res) => {
    try {
        const db = getDB();
        await db.collection("category").deleteOne({
            _id: new ObjectId(req.params.id)
        });
        res.redirect("/admin/category");
    } catch (error) {
        console.log(error);
        res.send("delete Category Error")
    }
});

module.exports = router;