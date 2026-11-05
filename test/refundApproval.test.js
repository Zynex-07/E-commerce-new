const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const crypto = require("node:crypto");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config({ path: "C:/E-commerce/.env" });

const { connectDB, getDB } = require("../config/db");
const {
    cancelOrderSafely,
    requestCustomerCancellation,
    approveCancellationAndRefund,
    rejectCancellationRequest,
    adminDirectCancelOrder,
    reconcileOrderRefund,
    processRazorpayWebhook,
    razorpayRefundRequest,
    isApiRequest
} = require("../services/orderService");

const userOrderRoutes = require("../router/user/userorderRoutes");
const adminOrderRoutes = require("../router/admin/orderRoutes");
const paymentRoutes = require("../router/user/paymentRoutes");

let db;
let server;
let baseUrl;
let currentTestUserId = null;

test.before(async () => {
    await connectDB();
    db = getDB();

    // Initialize express server for route-level integration testing
    const app = express();
    app.use(express.json({
        verify: (req, res, buf) => {
            req.rawBody = buf;
        }
    }));
    app.use(express.urlencoded({ extended: true }));

    app.use((req, res, next) => {
        req.session = {
            userID: currentTestUserId,
            userName: "Test User",
            admin: true,
            adminUsername: "admin_test",
            adminEmail: "admin@test.com"
        };
        next();
    });

    app.use("/order", userOrderRoutes);
    app.use("/admin/order", adminOrderRoutes);
    app.use("/payment", paymentRoutes);

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
        await db.collection("orders").deleteMany({ _testMarker: "refund_approval_test" });
        await db.collection("product").deleteMany({ _testMarker: "refund_approval_test" });
    }
    setTimeout(() => process.exit(0), 100);
});

test.describe("AAK Clothing Order Cancellation & Refund Approval System", () => {

    test("1. Customer cancellation on Paid order: creates 'Pending Approval', stock is NOT restored, NO refund", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Linen Shirt",
            stock: 8,
            price: 1200,
            _testMarker: "refund_approval_test"
        });

        const userId = new ObjectId().toString();
        const order = await db.collection("orders").insertOne({
            userID: userId,
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_cust_001",
            products: [{ productID: prod.insertedId, qty: 2, price: 1200 }],
            total: 2400,
            createdAt: new Date(),
            _testMarker: "refund_approval_test"
        });

        const reqResult = await requestCustomerCancellation({
            db,
            orderId: order.insertedId,
            userId,
            reason: "Ordered wrong size"
        });

        assert.equal(reqResult.success, true);
        assert.equal(reqResult.code, "CANCELLATION_REQUESTED");
        assert.equal(reqResult.status, 200);

        // Verify order status in DB
        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Paid", "Order status must remain 'Paid'");
        assert.equal(updatedOrder.cancellationStatus, "Pending Approval");
        assert.equal(updatedOrder.cancellationRequest.status, "Pending Approval");
        assert.equal(updatedOrder.cancellationRequest.reason, "Ordered wrong size");
        assert.ok(updatedOrder.cancellationRequest.requestedAt instanceof Date);

        // Verify stock is NOT restored yet
        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 8, "Stock must NOT be restored on cancellation request");
    });

    test("2. Duplicate customer cancellation request is blocked", async () => {
        const userId = new ObjectId().toString();
        const order = await db.collection("orders").insertOne({
            userID: userId,
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_cust_dup",
            cancellationStatus: "Pending Approval",
            products: [],
            total: 1000,
            createdAt: new Date(),
            _testMarker: "refund_approval_test"
        });

        const dupResult = await requestCustomerCancellation({
            db,
            orderId: order.insertedId,
            userId,
            reason: "Trying again"
        });

        assert.equal(dupResult.success, false);
        assert.equal(dupResult.code, "ALREADY_REQUESTED");
        assert.equal(dupResult.status, 400);
    });

    test("3. Customer cancellation on unpaid ('Pending') order cancels immediately and restores stock", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Cotton Cap",
            stock: 15,
            price: 300,
            _testMarker: "refund_approval_test"
        });

        const userId = new ObjectId().toString();
        const order = await db.collection("orders").insertOne({
            userID: userId,
            status: "Pending",
            products: [{ productID: prod.insertedId, qty: 3, price: 300 }],
            total: 900,
            createdAt: new Date(),
            _testMarker: "refund_approval_test"
        });

        const cancelResult = await requestCustomerCancellation({
            db,
            orderId: order.insertedId,
            userId
        });

        assert.equal(cancelResult.success, true);
        assert.equal(cancelResult.code, "CANCELLED");

        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Cancelled");
        assert.equal(updatedOrder.stockRestored, true);

        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 18, "Stock should be restored immediately for unpaid order");
    });

    test("4. Admin approval: initiates Razorpay refund, marks Cancelled, and restores stock once", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Silk Dress",
            stock: 5,
            price: 2500,
            _testMarker: "refund_approval_test"
        });

        const userId = new ObjectId().toString();
        const order = await db.collection("orders").insertOne({
            userID: userId,
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_appr_001",
            cancellationStatus: "Pending Approval",
            products: [{ productID: prod.insertedId, qty: 1, price: 2500 }],
            total: 2500,
            createdAt: new Date(),
            _testMarker: "refund_approval_test"
        });

        let requesterCalled = false;
        let requestedPaymentId = null;
        let requestedAmountPaise = null;

        const mockRequester = async (paymentId, amountPaise, notes) => {
            requesterCalled = true;
            requestedPaymentId = paymentId;
            requestedAmountPaise = amountPaise;
            return {
                id: "rfnd_mock_123456",
                entity: "refund",
                amount: amountPaise,
                currency: "INR",
                status: "processed",
                speed_processed: "optimum"
            };
        };

        const approvalResult = await approveCancellationAndRefund({
            db,
            orderId: order.insertedId,
            adminUser: "super_admin",
            requester: mockRequester
        });

        assert.equal(approvalResult.success, true);
        assert.equal(approvalResult.code, "APPROVED_AND_REFUNDED");
        assert.equal(approvalResult.status, 200);
        assert.equal(requesterCalled, true);
        assert.equal(requestedPaymentId, "pay_test_appr_001");
        assert.equal(requestedAmountPaise, 250000); // 2500 * 100 paise

        // Verify order in MongoDB
        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Cancelled");
        assert.equal(updatedOrder.cancellationStatus, "Approved");
        assert.equal(updatedOrder.refundStatus, "Refunded");
        assert.equal(updatedOrder.stockRestored, true);
        assert.equal(updatedOrder.refund.refundId, "rfnd_mock_123456");
        assert.equal(updatedOrder.refund.amount, 2500);
        assert.equal(updatedOrder.refund.amountPaise, 250000);
        assert.equal(updatedOrder.cancellationRequest.status, "Approved");
        assert.equal(updatedOrder.cancellationRequest.reviewedBy, "super_admin");

        // Verify stock is restored once (5 + 1 = 6)
        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 6);
    });

    test("5. Duplicate approval attempt on already cancelled/refunded order is blocked", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Denim Jacket",
            stock: 10,
            price: 3000,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u123",
            status: "Cancelled",
            cancellationStatus: "Approved",
            refundStatus: "Refunded",
            refund: { refundId: "rfnd_prev_999", amount: 3000 },
            stockRestored: true,
            paymentId: "pay_test_prev_999",
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 3000,
            _testMarker: "refund_approval_test"
        });

        let mockCalls = 0;
        const mockRequester = async () => {
            mockCalls++;
            return { id: "rfnd_should_not_happen" };
        };

        const dupApproval = await approveCancellationAndRefund({
            db,
            orderId: order.insertedId,
            requester: mockRequester
        });

        assert.equal(dupApproval.success, false);
        assert.equal(dupApproval.code, "ALREADY_CANCELLED");
        assert.equal(mockCalls, 0, "Razorpay must NOT be called on already cancelled order");

        // Verify stock didn't change
        const prodCheck = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodCheck.stock, 10, "Stock must NOT be restored again");
    });

    test("6. Concurrency safety: 10 parallel approval requests result in exactly ONE refund & ONE stock restoration", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Hoodie",
            stock: 20,
            price: 1500,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_conc",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_conc_001",
            cancellationStatus: "Pending Approval",
            products: [{ productID: prod.insertedId, qty: 2 }],
            total: 3000,
            _testMarker: "refund_approval_test"
        });

        let razorpayCallCount = 0;
        const mockRequester = async (paymentId, amountPaise) => {
            razorpayCallCount++;
            // Simulate 20ms network latency to test race condition window
            await new Promise(r => setTimeout(r, 20));
            return {
                id: `rfnd_conc_${Date.now()}`,
                entity: "refund",
                amount: amountPaise,
                currency: "INR",
                status: "processed"
            };
        };

        // Fire 10 parallel approval calls simultaneously
        const promises = Array.from({ length: 10 }, (_, i) =>
            approveCancellationAndRefund({
                db,
                orderId: order.insertedId,
                adminUser: `admin_${i}`,
                requester: mockRequester
            })
        );

        const results = await Promise.all(promises);

        const successCount = results.filter(r => r.success && r.code === "APPROVED_AND_REFUNDED").length;
        const concurrentRejections = results.filter(r => !r.success && (r.code === "CONCURRENT_APPROVAL" || r.code === "ALREADY_CANCELLED")).length;

        assert.equal(successCount, 1, "Exactly one approval must succeed");
        assert.equal(concurrentRejections, 9, "All 9 other parallel requests must be rejected safely");
        assert.equal(razorpayCallCount, 1, "Razorpay refund API must be called exactly once");

        // Verify stock restored strictly once (20 + 2 = 22)
        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 22, "Stock must be restored exactly once (22)");

        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Cancelled");
        assert.equal(updatedOrder.refundStatus, "Refunded");
        assert.equal(updatedOrder.stockRestored, true);
    });

    test("7. Razorpay failure: Order remains 'Paid', refundStatus becomes 'Failed', stock NOT restored", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Sweater",
            stock: 7,
            price: 1800,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_fail",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_fail_001",
            cancellationStatus: "Pending Approval",
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 1800,
            _testMarker: "refund_approval_test"
        });

        const failingRequester = async () => {
            const err = new Error("Payment has already been fully refunded or payment ID is invalid");
            err.statusCode = 400;
            throw err;
        };

        const result = await approveCancellationAndRefund({
            db,
            orderId: order.insertedId,
            requester: failingRequester
        });

        assert.equal(result.success, false);
        assert.equal(result.code, "RAZORPAY_REFUND_FAILED");
        assert.equal(result.status, 400);

        // Verify database state: order remains Paid, stock untouched
        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Paid", "Order must NOT be marked Cancelled if refund fails");
        assert.equal(updatedOrder.cancellationStatus, "Pending Approval");
        assert.equal(updatedOrder.refundStatus, "Failed");
        assert.ok(updatedOrder.refundError.includes("Payment has already been fully refunded"));
        assert.equal(updatedOrder.refundLockAt, undefined, "Lock must be released on failure");

        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 7, "Stock must NOT be restored if refund fails");
    });

    test("8. Admin rejection: order remains active ('Paid'), stock untouched, reason saved", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Trousers",
            stock: 12,
            price: 1600,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_rej",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_rej_001",
            cancellationStatus: "Pending Approval",
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 1600,
            _testMarker: "refund_approval_test"
        });

        const rejectResult = await rejectCancellationRequest({
            db,
            orderId: order.insertedId,
            adminUser: "support_lead",
            reason: "Item is already customized and packaged"
        });

        assert.equal(rejectResult.success, true);
        assert.equal(rejectResult.code, "REJECTED");
        assert.equal(rejectResult.status, 200);

        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Paid", "Order must remain Paid");
        assert.equal(updatedOrder.cancellationStatus, "Rejected");
        assert.equal(updatedOrder.cancellationRequest.status, "Rejected");
        assert.equal(updatedOrder.cancellationRequest.rejectionReason, "Item is already customized and packaged");
        assert.equal(updatedOrder.cancellationRequest.reviewedBy, "support_lead");
        assert.ok(updatedOrder.cancellationRequest.reviewedAt instanceof Date);

        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 12, "Stock must remain unchanged on rejection");
    });

    test("9. Admin direct cancellation on Paid order triggers Razorpay refund and restores stock once", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Leather Belt",
            stock: 30,
            price: 750,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_direct_paid",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_direct_001",
            products: [{ productID: prod.insertedId, qty: 2 }],
            total: 1500,
            _testMarker: "refund_approval_test"
        });

        let directRequesterCalled = false;
        const mockRequester = async (paymentId, amountPaise) => {
            directRequesterCalled = true;
            return {
                id: "rfnd_direct_987",
                entity: "refund",
                amount: amountPaise,
                currency: "INR",
                status: "processed"
            };
        };

        const directResult = await adminDirectCancelOrder({
            db,
            orderId: order.insertedId,
            adminUser: "ops_admin",
            requester: mockRequester
        });

        assert.equal(directResult.success, true);
        assert.equal(directResult.code, "CANCELLED_AND_REFUNDED");
        assert.equal(directRequesterCalled, true);

        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Cancelled");
        assert.equal(updatedOrder.refundStatus, "Refunded");
        assert.equal(updatedOrder.refund.refundId, "rfnd_direct_987");
        assert.equal(updatedOrder.stockRestored, true);

        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 32, "Stock must be restored once (30 + 2 = 32)");
    });

    test("10. Admin direct cancellation on Unpaid order does NOT call Razorpay and cancels safely", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Socks Pack",
            stock: 50,
            price: 200,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_direct_unpaid",
            status: "Pending",
            products: [{ productID: prod.insertedId, qty: 5 }],
            total: 1000,
            _testMarker: "refund_approval_test"
        });

        let requesterCalled = false;
        const mockRequester = async () => {
            requesterCalled = true;
            return { id: "rfnd_unexpected" };
        };

        const result = await adminDirectCancelOrder({
            db,
            orderId: order.insertedId,
            requester: mockRequester
        });

        assert.equal(result.success, true);
        assert.equal(result.code, "CANCELLED");
        assert.equal(requesterCalled, false, "Razorpay must NOT be called for unpaid order");

        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 55);
    });

    test("11. Server-side amount protection: refund amount is strictly derived from verified DB order total", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Formal Suit",
            stock: 3,
            price: 4999.50,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_sec",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_security_001",
            cancellationStatus: "Pending Approval",
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 4999.50,
            _testMarker: "refund_approval_test"
        });

        let receivedAmountPaise = null;
        const verifyingRequester = async (paymentId, amountPaise) => {
            receivedAmountPaise = amountPaise;
            return {
                id: "rfnd_verified_amt",
                entity: "refund",
                amount: amountPaise,
                currency: "INR",
                status: "processed"
            };
        };

        const result = await approveCancellationAndRefund({
            db,
            orderId: order.insertedId,
            requester: verifyingRequester
        });

        assert.equal(result.success, true);
        // 4999.50 * 100 = 499950 paise
        assert.equal(receivedAmountPaise, 499950, "Refund amount must exactly match Math.round(order.total * 100)");
    });

    test("12. Route-level integration: POST /admin/order/approve-cancellation/:id API call", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Cargo Pants",
            stock: 14,
            price: 1400,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_route_appr",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_route_001",
            cancellationStatus: "Pending Approval",
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 1400,
            _testMarker: "refund_approval_test"
        });

        // Test rejecting invalid order ID
        const invalidRes = await fetch(`${baseUrl}/admin/order/approve-cancellation/invalidid`, {
            method: "POST",
            headers: { "Accept": "application/json" }
        });
        assert.equal(invalidRes.status, 400);
        const invalidData = await invalidRes.json();
        assert.equal(invalidData.ok, false);

        // Test rejecting when order is not pending approval
        const unpendingOrder = await db.collection("orders").insertOne({
            userID: "u_not_pending",
            status: "Paid",
            products: [],
            total: 500,
            _testMarker: "refund_approval_test"
        });

        const notPendingRes = await fetch(`${baseUrl}/admin/order/approve-cancellation/${unpendingOrder.insertedId}`, {
            method: "POST",
            headers: { "Accept": "application/json" }
        });
        assert.equal(notPendingRes.status, 400);
        const notPendingData = await notPendingRes.json();
        assert.equal(notPendingData.code, "NOT_PENDING_APPROVAL");
    });

    test("13. Route-level integration: POST /admin/order/reject-cancellation/:id API call", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Polo Shirt",
            stock: 22,
            price: 800,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_route_rej",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_route_rej_001",
            cancellationStatus: "Pending Approval",
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 800,
            _testMarker: "refund_approval_test"
        });

        const res = await fetch(`${baseUrl}/admin/order/reject-cancellation/${order.insertedId}`, {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ reason: "Order has already been handed over to courier" })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.ok, true);
        assert.equal(data.code, "REJECTED");

        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.cancellationStatus, "Rejected");
        assert.equal(updatedOrder.cancellationRequest.rejectionReason, "Order has already been handed over to courier");
    });

    test("14. Live Razorpay configuration check: connects securely and handles live response in Test Mode", async () => {
        // Verify key presence
        assert.ok(process.env.RAZORPAY_KEY_ID, "RAZORPAY_KEY_ID must be configured in .env");
        assert.ok(process.env.RAZORPAY_KEY_SECRET, "RAZORPAY_KEY_SECRET must be configured in .env");

        // Test that live razorpayRefundRequest sends real HTTPS request to api.razorpay.com
        // When given a mock/non-existent payment ID, Razorpay should respond with HTTP 400 bad request,
        // which razorpayRefundRequest will reject with the Razorpay error description (e.g. "The id provided does not exist")
        await assert.rejects(
            async () => {
                await razorpayRefundRequest("pay_nonexistent_test_12345", 10000, { test: "live_connectivity" });
            },
            (err) => {
                assert.ok(err instanceof Error);
                // Must receive an actual error message from Razorpay API or bad request
                assert.ok(
                    err.message.toLowerCase().includes("id") ||
                    err.message.toLowerCase().includes("exist") ||
                    err.message.toLowerCase().includes("bad request") ||
                    err.message.toLowerCase().includes("razorpay") ||
                    err.message.toLowerCase().includes("payment"),
                    `Expected authentic Razorpay error description, got: ${err.message}`
                );
                return true;
            }
        );
    });

    test("15. Network timeout / dropped connection: transitions to 'Requires Reconciliation', not 'Failed', stock NOT restored", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Blazer",
            stock: 4,
            price: 3500,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_timeout_01",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_timeout_001",
            cancellationStatus: "Pending Approval",
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 3500,
            _testMarker: "refund_approval_test"
        });

        const timeoutRequester = async () => {
            const err = new Error("ESOCKETTIMEDOUT: Gateway connection dropped while awaiting refund response");
            err.isTimeout = true;
            err.isNetworkError = true;
            throw err;
        };

        const result = await approveCancellationAndRefund({
            db,
            orderId: order.insertedId,
            requester: timeoutRequester
        });

        assert.equal(result.success, false);
        assert.equal(result.code, "REFUND_REQUIRES_RECONCILIATION");
        assert.equal(result.status, 504);

        // Verify database state: order remains Paid (NOT cancelled), stock untouched, status is 'Requires Reconciliation'
        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Paid", "Order must NOT be marked Cancelled on network timeout");
        assert.equal(updatedOrder.refundStatus, "Requires Reconciliation", "Must enter safe uncertain state, NOT Failed");
        assert.equal(updatedOrder.reconciliationPending, true);
        assert.ok(updatedOrder.internalRefundRef, "Internal refund reference must be recorded");

        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 4, "Stock must NOT be restored on uncertain outcome");
    });

    test("16. Retry during uncertain outcome is blocked: cannot create duplicate refund without reconciliation", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Linen Trousers",
            stock: 10,
            price: 2000,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_retry_rec",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_retry_rec_001",
            cancellationStatus: "Pending Approval",
            refundStatus: "Requires Reconciliation",
            internalRefundRef: "ref_prev_uncertain_999",
            reconciliationPending: true,
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 2000,
            _testMarker: "refund_approval_test"
        });

        let duplicateRefundCalls = 0;
        const duplicateRequester = async () => {
            duplicateRefundCalls++;
            return { id: "rfnd_duplicate_should_not_happen" };
        };

        // Simulated lister that cannot connect to Razorpay (e.g. network still down)
        const failingLister = async () => {
            throw new Error("Cannot reach Razorpay to list refunds");
        };

        const retryResult = await approveCancellationAndRefund({
            db,
            orderId: order.insertedId,
            requester: duplicateRequester,
            lister: failingLister
        });

        assert.equal(retryResult.success, false);
        assert.equal(retryResult.code, "REFUND_REQUIRES_RECONCILIATION");
        assert.equal(duplicateRefundCalls, 0, "Must NEVER create a second refund while previous outcome is unresolved");

        const prodCheck = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(prodCheck.stock, 10, "Stock must remain unchanged");
    });

    test("17. Successful reconciliation: confirms previous refund from Razorpay list, cancels order, restores stock once", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Winter Scarf",
            stock: 15,
            price: 900,
            _testMarker: "refund_approval_test"
        });

        const internalRef = `ref_recon_${Date.now()}`;
        const order = await db.collection("orders").insertOne({
            userID: "u_rec_success",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_rec_success_001",
            cancellationStatus: "Pending Approval",
            refundStatus: "Requires Reconciliation",
            internalRefundRef: internalRef,
            reconciliationPending: true,
            products: [{ productID: prod.insertedId, qty: 2 }],
            total: 1800,
            _testMarker: "refund_approval_test"
        });

        // Mock lister returns Razorpay collection confirming that Razorpay did process the refund!
        const successfulLister = async (paymentId) => {
            return {
                entity: "collection",
                count: 1,
                items: [
                    {
                        id: "rfnd_from_reconciliation_001",
                        entity: "refund",
                        amount: 180000, // 1800 * 100 paise
                        currency: "INR",
                        payment_id: paymentId,
                        notes: { internalRefundRef: internalRef },
                        status: "processed",
                        created_at: Math.floor(Date.now() / 1000)
                    }
                ]
            };
        };

        const recResult = await reconcileOrderRefund({
            db,
            orderId: order.insertedId,
            adminUser: "rec_admin",
            lister: successfulLister
        });

        assert.equal(recResult.success, true);
        assert.equal(recResult.resolved, true);
        assert.equal(recResult.action, "REFUND_CONFIRMED");
        assert.equal(recResult.code, "RECONCILED_AND_REFUNDED");
        assert.equal(recResult.refund.refundId, "rfnd_from_reconciliation_001");

        // Verify order in database
        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Cancelled");
        assert.equal(updatedOrder.refundStatus, "Refunded");
        assert.equal(updatedOrder.stockRestored, true);
        assert.equal(updatedOrder.reconciliationPending, false);

        // Verify stock is restored once (15 + 2 = 17)
        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 17);
    });

    test("18. Failed reconciliation: proves no refund was created on Razorpay, transitions to 'Failed', stock untouched", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Cardigan",
            stock: 8,
            price: 1500,
            _testMarker: "refund_approval_test"
        });

        const order = await db.collection("orders").insertOne({
            userID: "u_rec_none",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId: "pay_test_rec_none_001",
            cancellationStatus: "Pending Approval",
            refundStatus: "Requires Reconciliation",
            internalRefundRef: "ref_none_123",
            reconciliationPending: true,
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 1500,
            _testMarker: "refund_approval_test"
        });

        // Mock lister returns empty collection: Razorpay has no refunds for this payment
        const emptyLister = async () => {
            return {
                entity: "collection",
                count: 0,
                items: []
            };
        };

        const recResult = await reconcileOrderRefund({
            db,
            orderId: order.insertedId,
            lister: emptyLister
        });

        assert.equal(recResult.success, true);
        assert.equal(recResult.resolved, true);
        assert.equal(recResult.action, "NO_REFUND_FOUND");
        assert.equal(recResult.code, "RECONCILED_NO_REFUND");

        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Paid", "Order remains Paid");
        assert.equal(updatedOrder.refundStatus, "Failed", "Transitions from Requires Reconciliation to Failed");
        assert.equal(updatedOrder.reconciliationPending, false);

        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 8, "Stock remains unchanged");
    });

    test("19. Webhook signature security: POST /payment/webhook rejects missing or invalid signatures with 400", async () => {
        const payload = JSON.stringify({
            entity: "event",
            event: "refund.processed",
            payload: { refund: { entity: { id: "rfnd_fake_001" } } }
        });

        // 1. Missing signature header
        const resMissing = await fetch(`${baseUrl}/payment/webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload
        });
        assert.equal(resMissing.status, 400);
        const dataMissing = await resMissing.json();
        assert.equal(dataMissing.ok, false);
        assert.ok(dataMissing.message.includes("Missing"));

        // 2. Invalid / forged signature header
        const resForged = await fetch(`${baseUrl}/payment/webhook`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-razorpay-signature": "forged_signature_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            },
            body: payload
        });
        assert.equal(resForged.status, 400);
        const dataForged = await resForged.json();
        assert.equal(dataForged.ok, false);
        assert.ok(dataForged.message.includes("Invalid webhook signature"));
    });

    test("20. Webhook refund.processed: valid signature updates order to Cancelled & Refunded, restores stock once", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Suede Loafers",
            stock: 12,
            price: 2800,
            _testMarker: "refund_approval_test"
        });

        const paymentId = "pay_test_webhook_proc_001";
        const order = await db.collection("orders").insertOne({
            userID: "u_wh_proc",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId,
            cancellationStatus: "Pending Approval",
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 2800,
            _testMarker: "refund_approval_test"
        });

        const webhookPayload = JSON.stringify({
            entity: "event",
            id: `evt_test_${Date.now()}`,
            event: "refund.processed",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_wh_proc_12345",
                        entity: "refund",
                        amount: 280000,
                        currency: "INR",
                        payment_id: paymentId,
                        status: "processed",
                        speed_processed: "optimum",
                        notes: { orderId: order.insertedId.toString() },
                        created_at: Math.floor(Date.now() / 1000)
                    }
                }
            }
        });

        const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
        const validSignature = crypto.createHmac("sha256", secret).update(webhookPayload).digest("hex");

        const res = await fetch(`${baseUrl}/payment/webhook`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-razorpay-signature": validSignature
            },
            body: webhookPayload
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);

        // Verify order in MongoDB
        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Cancelled");
        assert.equal(updatedOrder.refundStatus, "Refunded");
        assert.equal(updatedOrder.refund.refundId, "rfnd_wh_proc_12345");
        assert.equal(updatedOrder.stockRestored, true);
        assert.equal(updatedOrder.webhookProcessed, true);

        // Verify stock is restored once (12 + 1 = 13)
        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 13);
    });

    test("21. Webhook duplicate delivery (idempotency): re-delivering refund.processed does not restore stock twice", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Ankle Boots",
            stock: 20,
            price: 3200,
            _testMarker: "refund_approval_test"
        });

        const paymentId = "pay_test_wh_dup_001";
        const eventId = `evt_dup_${Date.now()}`;
        const refundId = "rfnd_wh_dup_99999";

        const order = await db.collection("orders").insertOne({
            userID: "u_wh_dup",
            status: "Cancelled",
            paymentMethod: "Razorpay",
            paymentId,
            refundStatus: "Refunded",
            refund: { refundId, amount: 3200 },
            stockRestored: true,
            processedWebhooks: [eventId],
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 3200,
            _testMarker: "refund_approval_test"
        });

        const webhookPayload = JSON.stringify({
            entity: "event",
            id: eventId,
            event: "refund.processed",
            payload: {
                refund: {
                    entity: {
                        id: refundId,
                        entity: "refund",
                        amount: 320000,
                        currency: "INR",
                        payment_id: paymentId,
                        status: "processed"
                    }
                }
            }
        });

        const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
        const validSignature = crypto.createHmac("sha256", secret).update(webhookPayload).digest("hex");

        const res = await fetch(`${baseUrl}/payment/webhook`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-razorpay-signature": validSignature
            },
            body: webhookPayload
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.idempotent, true);

        // Verify stock is strictly NOT restored again (remains 20)
        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 20, "Stock must NOT be restored a second time on duplicate webhook");
    });

    test("22. Webhook refund.failed: records failure, preserves active 'Paid' order, stock remains untouched", async () => {
        const prod = await db.collection("product").insertOne({
            name: "Wool Trenchcoat",
            stock: 6,
            price: 6000,
            _testMarker: "refund_approval_test"
        });

        const paymentId = "pay_test_wh_fail_001";
        const order = await db.collection("orders").insertOne({
            userID: "u_wh_fail",
            status: "Paid",
            paymentMethod: "Razorpay",
            paymentId,
            refundStatus: "Processing",
            products: [{ productID: prod.insertedId, qty: 1 }],
            total: 6000,
            _testMarker: "refund_approval_test"
        });

        const webhookPayload = JSON.stringify({
            entity: "event",
            id: `evt_fail_${Date.now()}`,
            event: "refund.failed",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_wh_failed_001",
                        entity: "refund",
                        amount: 600000,
                        currency: "INR",
                        payment_id: paymentId,
                        status: "failed",
                        error_description: "Customer bank account is closed or invalid"
                    }
                }
            }
        });

        const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
        const validSignature = crypto.createHmac("sha256", secret).update(webhookPayload).digest("hex");

        const res = await fetch(`${baseUrl}/payment/webhook`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-razorpay-signature": validSignature
            },
            body: webhookPayload
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);

        const updatedOrder = await db.collection("orders").findOne({ _id: order.insertedId });
        assert.equal(updatedOrder.status, "Paid", "Order must remain Paid on refund failure");
        assert.equal(updatedOrder.refundStatus, "Failed");
        assert.ok(updatedOrder.refundError.includes("Customer bank account is closed"));

        const updatedProd = await db.collection("product").findOne({ _id: prod.insertedId });
        assert.equal(updatedProd.stock, 6, "Stock must remain unchanged");
    });
});
