const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { ObjectId } = require("mongodb");
require("dotenv").config({ path: "C:/E-commerce/.env" });

const { connectDB, getDB } = require("../config/db");
const userOrderRoutes = require("../router/user/userorderRoutes");
const adminOrderRoutes = require("../router/admin/orderRoutes");

let db;
let server;
let baseUrl;

let currentTestUserId = null;

test.before(async () => {
    await connectDB();
    db = getDB();

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use((req, res, next) => {
        req.session = {
            userID: currentTestUserId,
            userName: "Test User",
            admin: true
        };
        next();
    });

    app.use("/order", userOrderRoutes);
    app.use("/admin/order", adminOrderRoutes);

    await new Promise(resolve => {
        server = http.createServer(app);
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });
});

test.after(async () => {
    if (server) {
        await new Promise(resolve => server.close(resolve));
    }
    if (db) {
        await db.collection("orders").deleteMany({ _testMarker: "api_endpoint_test" });
        await db.collection("product").deleteMany({ _testMarker: "api_endpoint_test" });
    }
    setTimeout(() => process.exit(0), 100);
});

test.describe("AAK Clothing Direct POST & API Order Cancellation Routes", () => {

    test("Direct POST to /order/cancel/:id requests cancellation for paid order and rejects duplicate request", async () => {
        currentTestUserId = new ObjectId().toString();

        const prod = await db.collection("product").insertOne({
            name: "API Test Jacket",
            stock: 10,
            _testMarker: "api_endpoint_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: currentTestUserId,
            status: "Paid",
            paymentId: "pay_test_jacket",
            products: [{ productID: prod.insertedId, qty: 2 }],
            total: 2000,
            _testMarker: "api_endpoint_test"
        });
        const orderId = order.insertedId.toString();

        // 1. Direct POST API request creates a cancellation request with status Pending Approval
        const firstRes = await fetch(`${baseUrl}/order/cancel/${orderId}`, {
            method: "POST",
            headers: { "Accept": "application/json" }
        });

        const firstJson = await firstRes.json();
        assert.equal(firstRes.status, 200);
        assert.equal(firstJson.ok, true);
        assert.equal(firstJson.message, "Cancellation request submitted. Waiting for admin approval.");

        // For paid order, stock is NOT restored yet upon customer request
        let prodCheck = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodCheck.stock, 10, "Stock must NOT be restored yet upon customer request");

        let orderCheck = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(orderCheck.cancellationStatus, "Pending Approval");
        assert.equal(orderCheck.status, "Paid");

        // 2. SECOND direct POST API request to cancel the SAME order is rejected
        const secondRes = await fetch(`${baseUrl}/order/cancel/${orderId}`, {
            method: "POST",
            headers: { "Accept": "application/json" }
        });

        const secondJson = await secondRes.json();
        assert.equal(secondRes.status, 400);
        assert.equal(secondJson.ok, false);
        assert.match(secondJson.message, /already pending approval/i);

        // Verify stock is still 10 (not restored)
        prodCheck = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodCheck.stock, 10);
    });

    test("Direct POST to /order/cancel/:id for Delivered order is rejected", async () => {
        currentTestUserId = new ObjectId().toString();

        const prod = await db.collection("product").insertOne({
            name: "API Delivered Shoes",
            stock: 8,
            _testMarker: "api_endpoint_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: currentTestUserId,
            status: "Delivered",
            products: [{ productID: prod.insertedId, qty: 1 }],
            _testMarker: "api_endpoint_test"
        });

        const res = await fetch(`${baseUrl}/order/cancel/${order.insertedId.toString()}`, {
            method: "POST",
            headers: { "Accept": "application/json" }
        });

        const json = await res.json();
        assert.equal(res.status, 400);
        assert.equal(json.ok, false);
        assert.equal(json.message, "Delivered orders cannot be cancelled");

        const prodCheck = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodCheck.stock, 8);
    });

    test("Admin direct POST /admin/order/cancel/:id cancels safely and prevents double cancel", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Admin Cancel Product",
            stock: 14,
            _testMarker: "api_endpoint_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: new ObjectId().toString(),
            status: "Pending",
            products: [{ productID: prod.insertedId, qty: 3 }],
            _testMarker: "api_endpoint_test"
        });
        const orderId = order.insertedId.toString();

        const firstRes = await fetch(`${baseUrl}/admin/order/cancel/${orderId}`, {
            method: "POST",
            headers: { "Accept": "application/json" }
        });

        const firstJson = await firstRes.json();
        assert.equal(firstRes.status, 200);
        assert.equal(firstJson.ok, true);

        let prodCheck = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodCheck.stock, 17, "Stock must be 14 + 3 = 17");

        const secondRes = await fetch(`${baseUrl}/admin/order/cancel/${orderId}`, {
            method: "POST",
            headers: { "Accept": "application/json" }
        });

        const secondJson = await secondRes.json();
        assert.equal(secondRes.status, 400);
        assert.equal(secondJson.ok, false);
        assert.equal(secondJson.message, "Order is already cancelled");

        prodCheck = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodCheck.stock, 17, "Stock must remain 17");
    });

    test("Admin POST /admin/order/status/:id with status: 'Cancelled' restores stock once and rejects re-cancelling", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Admin Status Product",
            stock: 20,
            _testMarker: "api_endpoint_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: new ObjectId().toString(),
            status: "Paid",
            products: [{ productID: prod.insertedId, qty: 5 }],
            _testMarker: "api_endpoint_test"
        });
        const orderId = order.insertedId.toString();

        const res1 = await fetch(`${baseUrl}/admin/order/status/${orderId}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({ status: "Cancelled" })
        });

        const json1 = await res1.json();
        assert.equal(res1.status, 200);
        assert.equal(json1.ok, true);

        let prodCheck = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodCheck.stock, 25, "Stock must be incremented by 5");

        const res2 = await fetch(`${baseUrl}/admin/order/status/${orderId}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({ status: "Pending" })
        });

        const json2 = await res2.json();
        assert.equal(res2.status, 400);
        assert.equal(json2.ok, false);
        assert.match(json2.message, /Cannot change status of a cancelled order/i);

        prodCheck = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodCheck.stock, 25);
    });

    test("Browser form submit (no JSON accept) receives 302 redirect", async () => {
        currentTestUserId = new ObjectId().toString();

        const prod = await db.collection("product").insertOne({
            name: "Form Test Item",
            stock: 5,
            _testMarker: "api_endpoint_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: currentTestUserId,
            status: "Paid",
            products: [{ productID: prod.insertedId, qty: 1 }],
            _testMarker: "api_endpoint_test"
        });

        const res = await fetch(`${baseUrl}/order/cancel/${order.insertedId.toString()}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "text/html,application/xhtml+xml,application/xml"
            },
            redirect: "manual"
        });

        assert.equal(res.status, 302);
        assert.equal(res.headers.get("location"), "/order");

        const prodCheck = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodCheck.stock, 5, "Stock must NOT be restored for Paid order on initial customer cancellation request");

        const orderCheck = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(orderCheck.cancellationStatus, "Pending Approval");
        assert.equal(orderCheck.status, "Paid");
    });
});
