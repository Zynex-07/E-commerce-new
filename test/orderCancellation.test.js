const test = require("node:test");
const assert = require("node:assert/strict");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config({ path: "C:/E-commerce/.env" });

const { cancelOrderSafely, isApiRequest } = require("../services/orderService");

let client;
let db;

test.before(async () => {
    client = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    db = client.db(process.env.DB_NAME);
});

test.after(async () => {
    // Clean up any remaining test documents
    if (db) {
        await db.collection("orders").deleteMany({ _testMarker: "order_cancellation_test" });
        await db.collection("product").deleteMany({ _testMarker: "order_cancellation_test" });
    }
    if (client) {
        await client.close();
    }
});

test.describe("AAK Clothing Order Cancellation Logic Verification", () => {

    test("1. A cancelled order cannot be cancelled again; stock is restored ONLY ONCE", async () => {
        // Create test product with initial stock 10
        const initialStock = 10;
        const orderQty = 2;
        const prodInsert = await db.collection("product").insertOne({
            name: "Test Shirt",
            stock: initialStock,
            price: 500,
            _testMarker: "order_cancellation_test"
        });
        const productId = prodInsert.insertedId;

        const testUserId = new ObjectId().toString();

        // Simulate order placed with status: 'Paid'
        const orderInsert = await db.collection("orders").insertOne({
            userID: testUserId,
            userName: "Test User",
            status: "Paid",
            products: [{ productID: productId, qty: orderQty, price: 500, total: 1000 }],
            total: 1000,
            createdAt: new Date(),
            _testMarker: "order_cancellation_test"
        });
        const orderId = orderInsert.insertedId;

        // First cancellation attempt
        const firstAttempt = await cancelOrderSafely({
            db,
            orderId,
            userId: testUserId,
            allowedStatuses: ["Pending", "Paid"]
        });

        assert.equal(firstAttempt.success, true, "First cancellation should succeed");
        assert.equal(firstAttempt.code, "CANCELLED");

        // Verify stock was restored by orderQty (10 + 2 = 12)
        let productAfterFirst = await db.collection("product").findOne({ _id: productId });
        assert.equal(productAfterFirst.stock, initialStock + orderQty, "Stock should be restored after first cancellation");

        // Verify order is now marked Cancelled and stockRestored: true
        let orderAfterFirst = await db.collection("orders").findOne({ _id: orderId });
        assert.equal(orderAfterFirst.status, "Cancelled");
        assert.equal(orderAfterFirst.stockRestored, true);

        // SECOND cancellation attempt (direct POST/API request simulation)
        const secondAttempt = await cancelOrderSafely({
            db,
            orderId,
            userId: testUserId,
            allowedStatuses: ["Pending", "Paid"]
        });

        assert.equal(secondAttempt.success, false, "Second cancellation attempt must fail");
        assert.equal(secondAttempt.code, "ALREADY_CANCELLED", "Error code should be ALREADY_CANCELLED");
        assert.equal(secondAttempt.status, 400);

        // Verify stock is STILL 12 (NOT restored again!)
        let productAfterSecond = await db.collection("product").findOne({ _id: productId });
        assert.equal(productAfterSecond.stock, initialStock + orderQty, "Stock must NOT be restored a second time");
    });

    test("2. Backend checks current order status before restoring stock", async () => {
        const prodInsert = await db.collection("product").insertOne({
            name: "Test Pants",
            stock: 20,
            price: 1200,
            _testMarker: "order_cancellation_test"
        });
        const productId = prodInsert.insertedId;
        const testUserId = new ObjectId().toString();

        // 2a. Delivered order cannot be cancelled
        const deliveredOrder = await db.collection("orders").insertOne({
            userID: testUserId,
            status: "Delivered",
            products: [{ productID: productId, qty: 3, price: 1200 }],
            total: 3600,
            _testMarker: "order_cancellation_test"
        });

        const deliveredAttempt = await cancelOrderSafely({
            db,
            orderId: deliveredOrder.insertedId,
            userId: testUserId
        });

        assert.equal(deliveredAttempt.success, false);
        assert.equal(deliveredAttempt.code, "ALREADY_DELIVERED");
        assert.equal(deliveredAttempt.status, 400);

        // Verify stock unchanged
        let prodCheck = await db.collection("product").findOne({ _id: productId });
        assert.equal(prodCheck.stock, 20, "Stock must not change for Delivered order");

        // 2b. Shipped order cannot be cancelled by user
        const shippedOrder = await db.collection("orders").insertOne({
            userID: testUserId,
            status: "Shipped",
            products: [{ productID: productId, qty: 1, price: 1200 }],
            total: 1200,
            _testMarker: "order_cancellation_test"
        });

        const shippedAttempt = await cancelOrderSafely({
            db,
            orderId: shippedOrder.insertedId,
            userId: testUserId,
            allowedStatuses: ["Pending", "Paid"]
        });

        assert.equal(shippedAttempt.success, false);
        assert.equal(shippedAttempt.code, "INVALID_STATUS");
        assert.equal(shippedAttempt.status, 400);

        prodCheck = await db.collection("product").findOne({ _id: productId });
        assert.equal(prodCheck.stock, 20, "Stock must not change for Shipped order");
    });

    test("3. Concurrency safety: 10 parallel cancellation requests restore stock ONLY ONCE", async () => {
        const initialStock = 50;
        const qtyA = 3;
        const qtyB = 5;

        const prodA = await db.collection("product").insertOne({
            name: "Item A",
            stock: initialStock,
            price: 100,
            _testMarker: "order_cancellation_test"
        });
        const prodB = await db.collection("product").insertOne({
            name: "Item B",
            stock: initialStock,
            price: 200,
            _testMarker: "order_cancellation_test"
        });

        const testUserId = new ObjectId().toString();
        const concurrentOrder = await db.collection("orders").insertOne({
            userID: testUserId,
            status: "Paid",
            products: [
                { productID: prodA.insertedId, qty: qtyA },
                { productID: prodB.insertedId, qty: qtyB }
            ],
            total: 1300,
            _testMarker: "order_cancellation_test"
        });

        // Fire 10 parallel cancellation requests simultaneously
        const parallelRequests = Array.from({ length: 10 }, () =>
            cancelOrderSafely({
                db,
                orderId: concurrentOrder.insertedId,
                userId: testUserId,
                allowedStatuses: ["Pending", "Paid"]
            })
        );

        const results = await Promise.all(parallelRequests);

        const successCount = results.filter(r => r.success).length;
        const failureCount = results.filter(r => !r.success).length;

        assert.equal(successCount, 1, "Exactly one request must succeed in cancelling");
        assert.equal(failureCount, 9, "All remaining 9 concurrent requests must be rejected");

        // Check product stock: must be incremented by EXACTLY qtyA and qtyB (not 10x)
        const updatedA = await db.collection("product").findOne({ _id: prodA.insertedId });
        const updatedB = await db.collection("product").findOne({ _id: prodB.insertedId });

        assert.equal(updatedA.stock, initialStock + qtyA, "Item A stock must be incremented only once");
        assert.equal(updatedB.stock, initialStock + qtyB, "Item B stock must be incremented only once");
    });

    test("4. Both 'Pending' and 'Paid' orders follow business rules and restore stock properly", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Item Pending Test",
            stock: 15,
            price: 400,
            _testMarker: "order_cancellation_test"
        });

        const testUserId = new ObjectId().toString();

        // Test Pending order cancellation
        const pendingOrder = await db.collection("orders").insertOne({
            userID: testUserId,
            status: "Pending",
            products: [{ productID: prod.insertedId, qty: 4 }],
            total: 1600,
            _testMarker: "order_cancellation_test"
        });

        const pendingResult = await cancelOrderSafely({
            db,
            orderId: pendingOrder.insertedId,
            userId: testUserId,
            allowedStatuses: ["Pending", "Paid"]
        });

        assert.equal(pendingResult.success, true);
        const prodAfterPending = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodAfterPending.stock, 19, "Pending order cancellation must restore stock (15 + 4 = 19)");
    });

    test("5. User isolation: A user cannot cancel another user's order", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Isolation Item",
            stock: 30,
            _testMarker: "order_cancellation_test"
        });

        const ownerId = new ObjectId().toString();
        const attackerId = new ObjectId().toString();

        const order = await db.collection("orders").insertOne({
            userID: ownerId,
            status: "Paid",
            products: [{ productID: prod.insertedId, qty: 2 }],
            _testMarker: "order_cancellation_test"
        });

        // Attacker attempts to cancel owner's order
        const attackResult = await cancelOrderSafely({
            db,
            orderId: order.insertedId,
            userId: attackerId,
            allowedStatuses: ["Pending", "Paid"]
        });

        assert.equal(attackResult.success, false);
        assert.equal(attackResult.code, "NOT_FOUND");
        assert.equal(attackResult.status, 404);

        // Stock unchanged
        const checkProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(checkProd.stock, 30);
    });

    test("6. isApiRequest detects AJAX, JSON Accept, and Content-Type headers properly", () => {
        assert.equal(isApiRequest({ xhr: true }), true);
        assert.equal(isApiRequest({ query: { ajax: "1" } }), true);
        assert.equal(isApiRequest({ headers: { "x-requested-with": "XMLHttpRequest" } }), true);
        assert.equal(isApiRequest({ headers: { accept: "application/json, text/plain, */*" } }), true);
        assert.equal(isApiRequest({ headers: { "content-type": "application/json" } }), true);
        assert.equal(isApiRequest({ headers: { accept: "text/html,application/xhtml+xml" } }), false);
        assert.equal(isApiRequest(null), false);
    });
});
