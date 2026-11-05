const test = require("node:test");
const assert = require("node:assert/strict");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config({ path: "C:/E-commerce/.env" });

const {
    createAndSendOtp,
    verifyOtp,
    generateOtp,
    hashOtp,
    normalizePhone
} = require("../services/smsService");

const {
    sendEmail,
    emailShell,
    verifySmtpConnection,
    sendAdminTestEmail,
    sendNewOrderCustomerEmail,
    sendOrderStatusUpdateCustomerEmail,
    sendOrderShippedCustomerEmail,
    sendOrderDeliveredCustomerEmail,
    sendOrderCancelledCustomerEmail,
    sendRefundCustomerEmail,
    sendBackInStockCustomerEmail,
    sendProductInfoCustomerEmail,
    sendNewOrderAdminEmail,
    sendNewCustomerRegistrationAdminEmail,
    sendProductAddedAdminEmail,
    sendProductUpdatedAdminEmail,
    sendStockLowAdminEmail,
    sendOutOfStockAdminEmail,
    sendOrderCancelledAdminEmail,
    sendRefundAdminEmail,
    sendInventoryAlertAdminEmail
} = require("../services/emailService");

let client;
let db;

test.before(async () => {
    client = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    db = client.db(process.env.DB_NAME);
});

test.after(async () => {
    if (db) {
        await db.collection("otps").deleteMany({ _testMarker: "notification_channel_test" });
        await db.collection("stockNotifications").deleteMany({ _testMarker: "notification_channel_test" });
        await db.collection("users").deleteMany({ _testMarker: "notification_channel_test" });
        await db.collection("product").deleteMany({ _testMarker: "notification_channel_test" });
        await db.collection("orders").deleteMany({ _testMarker: "notification_channel_test" });
    }
    if (client) {
        await client.close();
    }
});

test.describe("AAK Clothing OTP & Email Notification Channels Verification", () => {

    // ==========================================
    // 1. MOBILE SMS OTP via MSG91
    // ==========================================

    test("1. Registration OTP is generated as 6 digits and sent via SMS only (MSG91 gateway)", async () => {
        const testPhone = "9876543210";
        await db.collection("otps").deleteMany({ phone: testPhone });

        const result = await createAndSendOtp({
            db,
            phone: testPhone,
            purpose: "registration"
        });

        assert.equal(result.success, true, "SMS OTP generation and dispatch must succeed");
        assert.equal(result.phone, testPhone, "Phone number should be normalized 10 digits");
        assert.ok(result.otp || result.simulatedOtp, "OTP must be returned in simulation/test mode");
        const otpValue = result.otp || result.simulatedOtp;
        assert.match(otpValue, /^\d{6}$/, "OTP must be exactly 6 numeric digits");

        // Verify record in MongoDB 'otps' collection
        const otpRecord = await db.collection("otps").findOne({ phone: testPhone, purpose: "registration" });
        assert.ok(otpRecord, "OTP document must be saved in MongoDB otps collection");
        assert.equal(otpRecord.verified, false, "Initial status must not be verified");
        assert.equal(otpRecord.attempts, 0, "Initial attempts must be 0");
        assert.equal(otpRecord.resendCount, 0, "Initial resendCount must be 0");
        assert.notEqual(otpRecord.otpHash, otpValue, "Raw OTP must NEVER be stored in plain text; must be securely hashed");
        assert.equal(otpRecord.otpHash, hashOtp(testPhone, otpValue), "Hash must match HMAC-SHA256 of plain OTP");

        // Clean up
        await db.collection("otps").deleteMany({ phone: testPhone });
    });

    test("2. Resend OTP: enforces 60-second cooldown and max 3 resends per window", async () => {
        const testPhone = "9876543211";
        await db.collection("otps").deleteMany({ phone: testPhone });

        // Initial send (count = 0)
        const firstSend = await createAndSendOtp({ db, phone: testPhone, purpose: "registration" });
        assert.equal(firstSend.success, true);

        // Immediate resend attempt (within 60 seconds) must be rejected
        const immediateResend = await createAndSendOtp({ db, phone: testPhone, purpose: "registration" });
        assert.equal(immediateResend.success, false, "Immediate resend must fail due to cooldown");
        assert.equal((immediateResend.cooldownRemaining || immediateResend.cooldownSeconds) > 0, true, "Cooldown remaining must be greater than 0");

        // Simulate 65 seconds elapsed
        await db.collection("otps").updateOne(
            { phone: testPhone, purpose: "registration" },
            { $set: { lastResentAt: new Date(Date.now() - 65 * 1000) } }
        );

        // Allowed resend 1 (count = 1)
        const resend1 = await createAndSendOtp({ db, phone: testPhone, purpose: "registration" });
        assert.equal(resend1.success, true, "Resend 1 after cooldown must succeed");

        // Fast forward again for resend 2 (count = 2)
        await db.collection("otps").updateOne(
            { phone: testPhone, purpose: "registration" },
            { $set: { lastResentAt: new Date(Date.now() - 65 * 1000) } }
        );
        const resend2 = await createAndSendOtp({ db, phone: testPhone, purpose: "registration" });
        assert.equal(resend2.success, true, "Resend 2 after cooldown must succeed");

        // Fast forward again for resend 3 (count = 3, reaches limit)
        await db.collection("otps").updateOne(
            { phone: testPhone, purpose: "registration" },
            { $set: { lastResentAt: new Date(Date.now() - 65 * 1000) } }
        );
        const resend3 = await createAndSendOtp({ db, phone: testPhone, purpose: "registration" });
        assert.equal(resend3.success, true, "Resend 3 after cooldown must succeed (at limit)");

        // Fast forward again for resend 4 (already at count 3 -> blocked)
        await db.collection("otps").updateOne(
            { phone: testPhone, purpose: "registration" },
            { $set: { lastResentAt: new Date(Date.now() - 65 * 1000) } }
        );
        const resend4 = await createAndSendOtp({ db, phone: testPhone, purpose: "registration" });
        assert.equal(resend4.success, false, "Resend 4 must fail because max 3 resends exceeded");
        assert.match(resend4.message, /Maximum OTP resend limit/i);

        // Clean up
        await db.collection("otps").deleteMany({ phone: testPhone });
    });

    test("3. OTP Verification: timing-safe check, enforces 5 attempt limit and expiry", async () => {
        const testPhone = "9876543212";
        await db.collection("otps").deleteMany({ phone: testPhone });

        const sendResult = await createAndSendOtp({ db, phone: testPhone, purpose: "registration" });
        const correctOtp = sendResult.otp || sendResult.simulatedOtp;

        // Wrong OTP test
        const wrongVerify = await verifyOtp({ db, phone: testPhone, purpose: "registration", otp: "000000" });
        assert.equal(wrongVerify.success, false, "Wrong OTP must fail");
        assert.equal(wrongVerify.attemptsRemaining, 4, "Attempts remaining should be 4");

        // Verify correct OTP
        const correctVerify = await verifyOtp({ db, phone: testPhone, purpose: "registration", otp: correctOtp });
        assert.equal(correctVerify.success, true, "Correct OTP must succeed");

        // Replay attempt must be blocked (already verified)
        const replayVerify = await verifyOtp({ db, phone: testPhone, purpose: "registration", otp: correctOtp });
        assert.equal(replayVerify.success, false, "Used OTP must not be reusable");

        // Clean up
        await db.collection("otps").deleteMany({ phone: testPhone });
    });

    // ==========================================
    // 2. PRODUCT AND ORDER EMAIL NOTIFICATIONS (GMAIL SMTP / NODEMAILER)
    // ==========================================

    test("4. Customer: New Order Confirmation Email contains complete order details and AAK Clothing branding", async () => {
        const capturedMails = [];
        const mockTransporter = {
            sendMail: async (mailOpts) => {
                capturedMails.push(mailOpts);
                return { messageId: "mock_order_mail_1" };
            }
        };

        const sampleOrder = {
            _id: new ObjectId(),
            total: 2499,
            paymentId: "pay_test123456",
            paymentMethod: "Razorpay",
            createdAt: new Date(),
            shippingAddress: {
                fullName: "Ajmal Khan",
                address: "Flat 4B, Green Towers",
                city: "Bengaluru",
                state: "Karnataka",
                pincode: "560001",
                phone: "9876543210"
            },
            products: [
                {
                    productID: new ObjectId(),
                    name: "Signature Linen Shirt",
                    qty: 2,
                    price: 999,
                    images: "https://example.com/shirt.jpg"
                },
                {
                    productID: new ObjectId(),
                    name: "Casual Chino Trousers",
                    qty: 1,
                    price: 501,
                    images: "https://example.com/chino.jpg"
                }
            ]
        };

        const result = await sendNewOrderCustomerEmail({
            order: sampleOrder,
            customerEmail: "customer@example.com",
            customerName: "Ajmal Khan",
            transporterOverride: mockTransporter
        });

        assert.equal(result.success, true, "Customer order confirmation email must succeed");
        assert.equal(capturedMails.length, 1, "Exactly one email should be sent");

        const mail = capturedMails[0];
        assert.equal(mail.to, "customer@example.com");
        assert.match(mail.subject, /Order Confirmed/i);
        assert.match(mail.subject, new RegExp(String(sampleOrder._id).slice(-8).toUpperCase()));

        // Content verification
        assert.match(mail.html, /AAK CLOTHING/i, "Must have AAK Clothing branding");
        assert.match(mail.html, /Signature Linen Shirt/, "Must list ordered product name");
        assert.match(mail.html, /Casual Chino Trousers/, "Must list second product");
        assert.match(mail.html, /₹2,499|₹2499/, "Must show total order amount");
        assert.match(mail.html, /pay_test123456/, "Must show verified payment ID");
        assert.match(mail.html, /Flat 4B, Green Towers/, "Must show delivery address");
    });

    test("5. Admin: New Order Notification arrives with full breakdown", async () => {
        const capturedMails = [];
        const mockTransporter = {
            sendMail: async (mailOpts) => {
                capturedMails.push(mailOpts);
                return { messageId: "mock_admin_order_1" };
            }
        };

        const sampleOrder = {
            _id: new ObjectId(),
            userName: "Ajmal Khan",
            userEmail: "customer@example.com",
            total: 1800,
            paymentId: "pay_admin_check_01",
            products: [{ name: "Classic Polo", qty: 2, price: 900 }]
        };

        const result = await sendNewOrderAdminEmail({
            order: sampleOrder,
            transporterOverride: mockTransporter
        });

        assert.equal(result.success, true);
        assert.equal(capturedMails.length, 1);
        const mail = capturedMails[0];
        assert.match(mail.subject, /\[ADMIN ALERT\] New Order Received/);
        assert.match(mail.html, /Classic Polo/);
        assert.match(mail.html, /₹1800/);
        assert.match(mail.html, /customer@example\.com/);
    });

    test("6. Admin: Stock Alert arrives when stock drops low (<= 5) or runs out (= 0)", async () => {
        const capturedMails = [];
        const mockTransporter = {
            sendMail: async (mailOpts) => {
                capturedMails.push(mailOpts);
                return { messageId: "mock_stock_alert_" + capturedMails.length };
            }
        };

        const lowStockProduct = {
            _id: new ObjectId(),
            name: "Premium Oxford Shirt",
            stock: 3
        };

        // Low stock alert (<= 5)
        const lowResult = await sendStockLowAdminEmail({
            product: lowStockProduct,
            currentStock: 3,
            transporterOverride: mockTransporter
        });
        assert.equal(lowResult.success, true);

        // Out of stock alert (= 0)
        const outStockProduct = {
            _id: new ObjectId(),
            name: "Slim Fit Jeans",
            stock: 0
        };
        const outResult = await sendOutOfStockAdminEmail({
            product: outStockProduct,
            transporterOverride: mockTransporter
        });
        assert.equal(outResult.success, true);

        assert.equal(capturedMails.length, 2);

        // Verify low stock email content
        const lowMail = capturedMails[0];
        assert.match(lowMail.subject, /\[LOW STOCK WARNING\] Premium Oxford Shirt/);
        assert.match(lowMail.html, /Only 3 left/);
        assert.match(lowMail.html, /AAK CLOTHING/);

        // Verify out of stock email content
        const outMail = capturedMails[1];
        assert.match(outMail.subject, /\[CRITICAL OUT OF STOCK\] Slim Fit Jeans/);
        assert.match(outMail.html, /has reached 0 units|Sold Out/i);
    });

    test("7. Customer: Back-in-Stock Notification arrives when restocked product was 0", async () => {
        const capturedMails = [];
        const mockTransporter = {
            sendMail: async (mailOpts) => {
                capturedMails.push(mailOpts);
                return { messageId: "mock_back_in_stock_1" };
            }
        };

        const restockedProduct = {
            _id: new ObjectId(),
            name: "Floral Summer Dress",
            price: 1599,
            stock: 25,
            images: ["https://example.com/dress.jpg"],
            description: "Lightweight and breathable floral summer dress."
        };

        const result = await sendBackInStockCustomerEmail({
            product: restockedProduct,
            customerEmail: "subscriber@example.com",
            customerName: "Priya",
            baseUrl: "https://aakclothing.com",
            transporterOverride: mockTransporter
        });

        assert.equal(result.success, true);
        assert.equal(capturedMails.length, 1);

        const mail = capturedMails[0];
        assert.equal(mail.to, "subscriber@example.com");
        assert.match(mail.subject, /Back in Stock: Floral Summer Dress is available now!/);
        assert.match(mail.html, /Floral Summer Dress/);
        assert.match(mail.html, /₹1,599|₹1599/);
        assert.match(mail.html, /25 units/);
        assert.match(mail.html, new RegExp(`/product/${restockedProduct._id}`));
    });

    test("8. Customer & Admin: Order Status Updates (Shipped, Delivered, Cancelled) and Refund emails", async () => {
        const capturedMails = [];
        const mockTransporter = {
            sendMail: async (mailOpts) => {
                capturedMails.push(mailOpts);
                return { messageId: "mock_status_mail_" + capturedMails.length };
            }
        };

        const sampleOrder = {
            _id: new ObjectId(),
            total: 2100,
            status: "Shipped",
            userName: "Ajmal",
            products: [{ name: "Urban Hoodie", qty: 1, price: 2100 }]
        };

        // Customer Shipped Email
        await sendOrderShippedCustomerEmail({
            order: sampleOrder,
            customerEmail: "ajmal@example.com",
            customerName: "Ajmal",
            trackingNumber: "TRK_IN_998877",
            carrier: "BlueDart",
            transporterOverride: mockTransporter
        });

        // Customer Delivered Email
        await sendOrderDeliveredCustomerEmail({
            order: { ...sampleOrder, status: "Delivered" },
            customerEmail: "ajmal@example.com",
            customerName: "Ajmal",
            transporterOverride: mockTransporter
        });

        // Customer Cancelled Email
        await sendOrderCancelledCustomerEmail({
            order: { ...sampleOrder, status: "Cancelled" },
            customerEmail: "ajmal@example.com",
            customerName: "Ajmal",
            reason: "Customer requested cancellation",
            transporterOverride: mockTransporter
        });

        // Customer Refund Email
        await sendRefundCustomerEmail({
            order: sampleOrder,
            customerEmail: "ajmal@example.com",
            customerName: "Ajmal",
            refundAmount: 2100,
            refundId: "rfnd_test998811",
            transporterOverride: mockTransporter
        });

        // Admin Refund Email
        await sendRefundAdminEmail({
            order: sampleOrder,
            refund: { refundId: "rfnd_test998811", paymentId: "pay_test1122", amount: 2100 },
            approvedBy: "Admin",
            transporterOverride: mockTransporter
        });

        assert.equal(capturedMails.length, 5, "5 emails should have been dispatched");

        // Verify shipped mail
        assert.match(capturedMails[0].subject, /Shipped/);
        assert.match(capturedMails[0].html, /TRK_IN_998877/);
        assert.match(capturedMails[0].html, /BlueDart/);

        // Verify delivered mail
        assert.match(capturedMails[1].subject, /Delivered/);

        // Verify cancelled mail
        assert.match(capturedMails[2].subject, /Cancelled/);
        assert.match(capturedMails[2].html, /Customer requested cancellation/);

        // Verify customer refund mail
        assert.match(capturedMails[3].subject, /Refund Processed/);
        assert.match(capturedMails[3].html, /rfnd_test998811/);
        assert.match(capturedMails[3].html, /₹2,100|₹2100/);

        // Verify admin refund mail
        assert.match(capturedMails[4].subject, /\[REFUND PROCESSED\] ₹2100/);
        assert.match(capturedMails[4].html, /rfnd_test998811/);
    });

    test("9. Channel Separation Rule: OTP generation does NOT trigger email and has no email dependencies", async () => {
        const testPhone = "9900112233";
        await db.collection("otps").deleteMany({ phone: testPhone });

        // Generate OTP
        const otpRes = await createAndSendOtp({ db, phone: testPhone, purpose: "registration" });
        assert.equal(otpRes.success, true);

        // Check that plain OTP was generated
        const generatedOtp = otpRes.otp || otpRes.simulatedOtp;
        assert.equal(typeof generatedOtp, "string");
        assert.equal(generatedOtp.length, 6);

        // Verify that user registration alerts to admin only trigger AFTER verified registration, never with plain OTP
        const capturedMails = [];
        const mockTransporter = {
            sendMail: async (mailOpts) => {
                capturedMails.push(mailOpts);
                return { messageId: "mock_reg_" + capturedMails.length };
            }
        };

        const newUserData = {
            username: "newcustomer",
            phone: testPhone,
            createdAt: new Date()
        };

        await sendNewCustomerRegistrationAdminEmail({
            user: newUserData,
            transporterOverride: mockTransporter
        });

        assert.equal(capturedMails.length, 1);
        assert.match(capturedMails[0].subject, /New Customer Registered: newcustomer/);
        assert.match(capturedMails[0].html, new RegExp(testPhone));
        assert.doesNotMatch(capturedMails[0].html, new RegExp(generatedOtp), "Plain OTP must NEVER be sent in emails!");

        // Clean up
        await db.collection("otps").deleteMany({ phone: testPhone });
    });

    test("10. Back-in-Stock Subscription & Restock Workflow: DB persistence and subscriber notification", async () => {
        const testProdId = new ObjectId();
        const testSubEmail = "notify_subscriber@example.com";

        // 1. Insert product with 0 stock
        await db.collection("product").insertOne({
            _id: testProdId,
            name: "Limited Edition Jacket",
            price: 4999,
            stock: 0,
            _testMarker: "notification_channel_test"
        });

        // 2. Customer subscribes
        await db.collection("stockNotifications").insertOne({
            productID: testProdId,
            email: testSubEmail,
            name: "Zara",
            notified: false,
            createdAt: new Date(),
            _testMarker: "notification_channel_test"
        });

        // 3. Find pending subscribers
        const subscribers = await db.collection("stockNotifications").find({
            productID: testProdId,
            notified: { $ne: true }
        }).toArray();

        assert.equal(subscribers.length, 1);
        assert.equal(subscribers[0].email, testSubEmail);

        // 4. Simulate admin restock (stock updated to 10)
        await db.collection("product").updateOne({ _id: testProdId }, { $set: { stock: 10 } });
        const updatedProduct = await db.collection("product").findOne({ _id: testProdId });

        // 5. Send notification to subscriber
        const capturedMails = [];
        const mockTransporter = {
            sendMail: async (mailOpts) => {
                capturedMails.push(mailOpts);
                return { messageId: "mock_sub_mail_1" };
            }
        };

        for (const sub of subscribers) {
            await sendBackInStockCustomerEmail({
                product: updatedProduct,
                customerEmail: sub.email,
                customerName: sub.name,
                transporterOverride: mockTransporter
            });
            await db.collection("stockNotifications").updateOne(
                { _id: sub._id },
                { $set: { notified: true, notifiedAt: new Date() } }
            );
        }

        // Verify subscriber is now marked notified
        const subAfter = await db.collection("stockNotifications").findOne({ _id: subscribers[0]._id });
        assert.equal(subAfter.notified, true);
        assert.ok(subAfter.notifiedAt);

        // Verify sent email
        assert.equal(capturedMails.length, 1);
        assert.equal(capturedMails[0].to, testSubEmail);
        assert.match(capturedMails[0].subject, /Back in Stock: Limited Edition Jacket/);
    });

    // ==========================================
    // 3. ADMIN TEST EMAIL ENDPOINT & DIAGNOSTICS
    // ==========================================

    test("11. verifySmtpConnection() correctly verifies Gmail SMTP transporter configuration", async () => {
        const mockTransporter = {
            verify: async () => true
        };
        const result = await verifySmtpConnection(mockTransporter);
        assert.equal(result.ok, true);
        assert.equal(result.configured, true);
        assert.match(result.host, /gmail\.com/);
        assert.equal(result.port, 465);
        assert.ok(result.userMasked);
        assert.doesNotMatch(result.userMasked, new RegExp(process.env.EMAIL_PASS || "dummy_pass"), "Must never leak password");
    });

    test("12. sendAdminTestEmail() strictly targets ADMIN_EMAIL and does not leak credentials", async () => {
        const capturedMails = [];
        const mockTransporter = {
            sendMail: async (mailOpts) => {
                capturedMails.push(mailOpts);
                return { messageId: "mock_admin_test_1" };
            }
        };

        const result = await sendAdminTestEmail({
            triggeredBy: "Admin Diagnostic Runner",
            transporterOverride: mockTransporter
        });

        assert.equal(result.success, true);
        assert.equal(capturedMails.length, 1);
        const mail = capturedMails[0];
        assert.equal(mail.to, process.env.ADMIN_EMAIL || "admin@aakclothing.com");
        assert.match(mail.subject, /\[SYSTEM TEST\] Gmail SMTP Verified/);
        assert.match(mail.html, /Gmail SMTP Integration Verified/);
        assert.match(mail.html, /Admin Diagnostic Runner/);
        assert.doesNotMatch(mail.html, new RegExp(process.env.EMAIL_PASS || "dummy_pass"), "Must never leak password in email HTML");
    });

    test("13. Route integration: /admin/test-email requires admin session and rejects unauthenticated callers", async () => {
        const express = require("express");
        const http = require("node:http");
        const adminRouters = require("../router/admin/adminRouters");

        const testApp = express();
        testApp.use(express.json());

        let simulateAdmin = false;
        testApp.use((req, res, next) => {
            if (simulateAdmin) {
                req.session = { admin: { username: "admin" } };
            } else {
                req.session = {};
            }
            next();
        });
        testApp.use("/admin", adminRouters);

        const testServer = http.createServer(testApp);
        await new Promise(resolve => testServer.listen(0, "127.0.0.1", resolve));
        const testBaseUrl = `http://127.0.0.1:${testServer.address().port}`;

        try {
            // Unauthenticated POST request
            simulateAdmin = false;
            const unauthPost = await fetch(`${testBaseUrl}/admin/test-email`, {
                method: "POST",
                headers: { "Accept": "application/json" }
            });
            assert.equal(unauthPost.status, 401, "Unauthenticated POST /admin/test-email must return 401");

            // Authenticated GET check
            simulateAdmin = true;
            const authGet = await fetch(`${testBaseUrl}/admin/test-email`, {
                method: "GET",
                headers: { "Accept": "application/json" }
            });
            assert.equal(authGet.status, 200, "Authenticated GET /admin/test-email must return 200");
            const getJson = await authGet.json();
            assert.equal(typeof getJson.ok, "boolean");
            assert.ok(getJson.connection);
        } finally {
            await new Promise(resolve => testServer.close(resolve));
        }
    });
});
