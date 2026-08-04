const express = require("express");
const path = require("path");

require("dotenv").config();
const session = require("express-session");
const { connectDB } = require("./config/db");

// Admin
const adminCategoryRoutes = require("./router/admin/categoryRoutes");
const productRoutes = require("./router/admin/productRoutes");
const orderRoutes = require("./router/admin/orderRoutes");
const adminUserRoutes = require("./router/admin/userRoutes");
const dashboardRoutes = require("./router/admin/dashboardRoutes")

// User
const homeRoutes = require("./router/user/homeRoutes");
const userproductRoutes = require("./router/user/userproductRouters");
const authRoutes = require("./router/user/authRoutes");
const cartRoutes = require("./router/user/cartRoutes");
const userorderRoutes = require("./router/user/userorderRoutes");
const addressRoutes = require("./router/user/addressRoutes")
const wishlistRoutes = require("./router/user/wishlistRoutes");

const app = express();
connectDB();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: "ecommerce-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24
    }
}));

app.use((req, res, next) => {
    res.locals.userID = req.session.userID;
    res.locals.userName = req.session.userName;
    next();
});

app.set("view engine", "ejs");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static("public"));

// Admin
app.use("/admin/category", adminCategoryRoutes);
app.use("/admin/product", productRoutes);
app.use("/admin/order", orderRoutes);
app.use("/admin/user", adminUserRoutes);
app.use("/admin/dashboard", dashboardRoutes);

// User
app.use("/", homeRoutes);
app.use("/product", userproductRoutes);
app.use("/auth", authRoutes);

//test Route
app.get("/test", (req, res) => {
    console.log("TEST ROUTE HIT");
    res.send("Working");
});

app.use("/cart", cartRoutes);
app.use("/order", userorderRoutes);
app.use("/address", addressRoutes);
app.use("/wishlist", wishlistRoutes);

const PORT = process.env.PORT || 3000;

(async () => {
    try {
        await connectDB();
        app.listen(PORT, () => {
            console.log(`Server Running : http://localhost:${PORT}/auth/login`);
        });
    } catch (error) {
        console.log(error);
    }
})();
