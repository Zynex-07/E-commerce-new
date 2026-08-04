const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

router.get("/", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.redirect("/auth/login");
        }
        const db = getDB();
        const user = await db.collection("users").findOne({
            _id: new ObjectId(req.session.userID)
        });
        res.render("user/address/index", {
            user
        });
    } catch (error) {
        console.log(error);
        res.send("Address Page Error");
    }
});

router.get("/edit", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.redirect("/auth/login");
        }
        const db = getDB();
        const user = await db.collection("users").findOne({
            _id: new ObjectId(req.session.userID)
        });
        res.render("user/address/edit", {
            user
        });
    } catch (error) {
        console.log(error);
        res.send("Edit Address Error");
    }
});

router.post("/save", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.redirect("/auth/login");
        }
        const {
            mobile,
            address,
            city,
            state,
            pincode,
            latitude,
            longitude
        } = req.body;
        const db = getDB();
        await db.collection("users").updateOne(
            {
                _id: new ObjectId(req.session.userID)
            },
            {
                $set: {
                    address: {
                        mobile,
                        address,
                        city,
                        state,
                        pincode,
                        latitude: latitude ? Number(latitude) : null,
                        longitude: longitude ? Number(longitude) : null
                    }
                }
            }
        );
        res.redirect("/address");
    } catch (error) {
        console.log(error);
        res.send("Save Address Error");
    }
});

module.exports = router;
