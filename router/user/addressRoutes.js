const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

function getUserId(req) {
    return ObjectId.isValid(req.session.userID) ? new ObjectId(req.session.userID) : null;
}

function clean(value) {
    return String(value || "").trim();
}

function renderError(res, user, error) {
    return res.status(400).render("user/address/edit", { user, error });
}

router.get("/", async (req, res) => {
    try {
        if (!req.session.userID) return res.redirect("/auth/login");
        const userId = getUserId(req);
        if (!userId) return res.redirect("/auth/login");
        const user = await getDB().collection("users").findOne({ _id: userId });
        if (!user) return res.redirect("/auth/login");
        res.render("user/address/index", { user });
    } catch (error) {
        console.error("Address Page Error:", error);
        res.status(500).send("Address Page Error");
    }
});

router.get("/edit", async (req, res) => {
    try {
        if (!req.session.userID) return res.redirect("/auth/login");
        const userId = getUserId(req);
        if (!userId) return res.redirect("/auth/login");
        const user = await getDB().collection("users").findOne({ _id: userId });
        if (!user) return res.redirect("/auth/login");
        res.render("user/address/edit", { user, error: null });
    } catch (error) {
        console.error("Edit Address Error:", error);
        res.status(500).send("Edit Address Error");
    }
});

router.post("/save", async (req, res) => {
    try {
        if (!req.session.userID) return res.redirect("/auth/login");
        const userId = getUserId(req);
        if (!userId) return res.redirect("/auth/login");

        const mobile = clean(req.body.mobile).replace(/\s+/g, "");
        const address = clean(req.body.address);
        const city = clean(req.body.city);
        const state = clean(req.body.state);
        const pincode = clean(req.body.pincode);
        const latitude = req.body.latitude !== "" && req.body.latitude != null ? Number(req.body.latitude) : null;
        const longitude = req.body.longitude !== "" && req.body.longitude != null ? Number(req.body.longitude) : null;

        const user = await getDB().collection("users").findOne({ _id: userId });
        if (!user) return res.redirect("/auth/login");

        if (!/^\d{10}$/.test(mobile)) return renderError(res, user, "Enter a valid 10-digit mobile number.");
        if (!address || address.length < 5) return renderError(res, user, "Enter your complete delivery address.");
        if (!city) return renderError(res, user, "City is required.");
        if (!state) return renderError(res, user, "State is required.");
        if (!/^\d{6}$/.test(pincode)) return renderError(res, user, "Enter a valid 6-digit pincode.");
        if (latitude !== null && !Number.isFinite(latitude)) return renderError(res, user, "Invalid latitude.");
        if (longitude !== null && !Number.isFinite(longitude)) return renderError(res, user, "Invalid longitude.");

        await getDB().collection("users").updateOne(
            { _id: userId },
            {
                $set: {
                    address: { mobile, address, city, state, pincode, latitude, longitude, updatedAt: new Date() }
                }
            }
        );

        res.redirect("/address");
    } catch (error) {
        console.error("Save Address Error:", error);
        res.status(500).send("Save Address Error");
    }
});

router.post("/delete", async (req, res) => {
    try {
        if (!req.session.userID) return res.redirect("/auth/login");
        const userId = getUserId(req);
        if (!userId) return res.redirect("/auth/login");
        await getDB().collection("users").updateOne({ _id: userId }, { $unset: { address: "" } });
        res.redirect("/address");
    } catch (error) {
        console.error("Delete Address Error:", error);
        res.status(500).send("Delete Address Error");
    }
});

module.exports = router;
