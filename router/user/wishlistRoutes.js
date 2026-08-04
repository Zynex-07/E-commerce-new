const express = require("express");
const router = express.Router();
const { getDB } = require("../../config/db");
const { ObjectId } = require("mongodb");

router.get("/add/:id", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.redirect("/auth/login");
        }
        const db = getDB();
        const result = await db.collection("users").updateOne(
            {
                _id: new ObjectId(req.session.userID),
                wishlist: {
                    $ne: new ObjectId(req.params.id)
                }
            },
            {
                $push: {
                    wishlist: new ObjectId(req.params.id)
                }
            }
        );
        res.redirect("/product");
    } catch (error) {
        console.log(error);
        res.send("Wishlist Add Error");
    }
});

router.get("/", async (req, res) => {
    try {
        if (!req.session.userID) {
            return res.redirect("/auth/login");
        }
        const db = getDB();
        const user = await db.collection("users").findOne(
            {
                _id: new ObjectId(req.session.userID)
            }
        );
        if (!user) {
            return res.send("User Not Found");
        }        
        const wishlist = await db.collection("product")
            .find({
                _id: {
                    $in: user.wishlist || []
                }
            })
            .toArray();

        res.render("user/wishlist", {
            wishlist
        });

    } catch (error) {
        console.log(error);
        res.send("Wishlist fetch Error");
    }
});

router.get("/remove/:id", async (req, res) => {
    try {
        const db = getDB();
        await db.collection("users").updateOne(
            {
                _id: new ObjectId(req.session.userID)
            },
            {
                $pull: {
                    wishlist: new ObjectId(req.params.id)
                }
            }
        );
        res.redirect("/wishlist");
    } catch (error) {
        console.log(error);
        res.send("wishlist Remove Error");        
    }
})

module.exports = router;