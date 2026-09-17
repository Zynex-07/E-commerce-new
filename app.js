const express = require("express");
const path = require("path");

require("dotenv").config();

const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const { connectDB, getDB } = require("./config/db");
const { ObjectId } = require("mongodb");
const { requireAdmin } = require("./middleware/adminAuth");

// Admin
const adminAuthRoutes = require("./router/admin/adminRouters");
const adminCategoryRoutes = require("./router/admin/categoryRoutes");
const productRoutes = require("./router/admin/productRoutes");
const orderRoutes = require("./router/admin/orderRoutes");
const adminUserRoutes = require("./router/admin/userRoutes");
const dashboardRoutes = require("./router/admin/dashboardRoutes");

// User
const homeRoutes = require("./router/user/homeRoutes");
const userproductRoutes = require("./router/user/userproductRouters");
const authRoutes = require("./router/user/authRoutes");
const cartRoutes = require("./router/user/cartRoutes");
const userorderRoutes = require("./router/user/userorderRoutes");
const addressRoutes = require("./router/user/addressRoutes");
const wishlistRoutes = require("./router/user/wishlistRoutes");
const paymentRoutes = require("./router/user/paymentRoutes");

const app = express();

// Heroku terminates HTTPS at its proxy. Trust the proxy so secure session
// cookies work correctly in production.
if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessionOptions = {
    secret: process.env.SESSION_SECRET || "change-this-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 24
    }
};

// Use MongoDB for sessions in production instead of Express MemoryStore.
if (process.env.MONGO_URL) {
    sessionOptions.store = MongoStore.create({
        mongoUrl: process.env.MONGO_URL,
        dbName: process.env.DB_NAME,
        collectionName: "sessions",
        ttl: 60 * 60 * 24,
        touchAfter: 24 * 3600
    });
}

app.use(session(sessionOptions));

app.use((req, res, next) => {
    res.locals.userID = req.session.userID;
    res.locals.userName = req.session.userName;
    res.locals.admin = req.session.admin || null;
    res.locals.cartCount = req.session.cartCount || 0;
    next();
});

app.set("view engine", "ejs");

app.use(express.static(path.join(__dirname, "public")));

// Admin authentication is public; everything else under /admin is protected.
app.use("/admin", adminAuthRoutes);
app.use("/admin", requireAdmin);

app.use("/admin/category", adminCategoryRoutes);
app.use("/admin/product", productRoutes);
app.use("/admin/order", orderRoutes);
app.use("/admin/user", adminUserRoutes);
app.use("/admin/dashboard", dashboardRoutes);

// User
app.use("/", homeRoutes);
app.use("/product", userproductRoutes);
app.use("/auth", authRoutes);
app.use("/cart", cartRoutes);
app.use("/payment", paymentRoutes);
app.use("/order", userorderRoutes);
app.use("/address", addressRoutes);
app.use("/wishlist", wishlistRoutes);

app.get("/test", (req, res) => {
    res.send("Working");
});

const PORT = process.env.PORT || 3000;

// One-time data repair for products created under the old MEN category ID.
// The category collection now contains the current MEN category, while some
// existing products still reference the deleted/old MEN category ObjectId.
async function migrateLegacyMenCategory() {
    const db = getDB();
    const menCategory = await db.collection("category").findOne({
        name: { $regex: /^mens?$/i }
    });

    if (!menCategory) {
        console.log("ℹ️ MEN category not found; skipping category migration.");
        return;
    }

    const legacyMenId = "6a0ef330d01ee0c10579a3dd";
    const currentMenId = menCategory._id;

    if (String(currentMenId) === legacyMenId) {
        return;
    }

    const result = await db.collection("product").updateMany(
        {
            $or: [
                { categoryId: new ObjectId(legacyMenId) },
                { categoryId: legacyMenId }
            ]
        },
        { $set: { categoryId: currentMenId } }
    );

    if (result.modifiedCount > 0) {
        console.log(`✅ MEN category repaired: ${result.modifiedCount} product(s) updated.`);
    }
}

(async () => {
    try {
        await connectDB();
        await migrateLegacyMenCategory();
        app.listen(PORT, () => {
            console.log(`Server Running : http://localhost:${PORT}/admin/login`);
        });
    } catch (error) {
        console.error("Server startup error:", error);
        process.exit(1);
    }
})();
