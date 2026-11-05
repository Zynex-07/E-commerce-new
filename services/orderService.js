const { ObjectId } = require("mongodb");
const https = require("https");
const {
    sendOrderCancelledCustomerEmail,
    sendRefundCustomerEmail,
    sendOrderCancelledAdminEmail,
    sendRefundAdminEmail
} = require("./emailService");

/**
 * Helper to identify whether a request expects an API / JSON response.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isApiRequest(req) {
    if (!req) return false;
    if (req.xhr) return true;
    if (req.query && req.query.ajax === "1") return true;

    const xRequestedWith = req.headers && req.headers["x-requested-with"];
    if (xRequestedWith && String(xRequestedWith).toLowerCase() === "xmlhttprequest") {
        return true;
    }

    const accept = req.headers && req.headers.accept;
    if (accept && (accept.includes("application/json") || accept.includes("application/vnd.api+json"))) {
        return true;
    }

    const contentType = req.headers && req.headers["content-type"];
    if (contentType && contentType.includes("application/json")) {
        return true;
    }

    return false;
}

/**
 * Determines whether a Razorpay error is an authoritative rejection (HTTP 4xx from Razorpay)
 * vs an uncertain network/timeout/socket issue.
 *
 * @param {any} err
 * @returns {boolean}
 */
function isDefinitiveRejection(err) {
    if (!err) return false;
    if (err.isTimeout === true || err.isNetworkError === true) return false;
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
        return true;
    }
    const msg = String(err.message || "").toLowerCase();
    if (
        msg.includes("timeout") ||
        msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("socket hang up") ||
        msg.includes("ehostunreach") ||
        msg.includes("etimedout") ||
        msg.includes("esockettimedout") ||
        msg.includes("gateway")
    ) {
        return false;
    }
    if (
        msg.includes("the id provided does not exist") ||
        msg.includes("bad_request_error") ||
        msg.includes("already been refunded") ||
        msg.includes("not found")
    ) {
        return true;
    }
    return false;
}

/**
 * Low-level Razorpay Refund API request helper.
 * Never logs or exposes credentials.
 *
 * @param {string} paymentId
 * @param {number} amountPaise
 * @param {Object} [notes]
 * @returns {Promise<Object>}
 */
function razorpayRefundRequest(paymentId, amountPaise, notes = {}) {
    return new Promise((resolve, reject) => {
        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;

        if (!keyId || !keySecret) {
            return reject(new Error("Razorpay keys are not configured in .env"));
        }
        if (!paymentId) {
            return reject(new Error("Missing Razorpay payment ID"));
        }

        const payload = {
            amount: amountPaise,
            speed: "optimum",
            notes
        };

        const body = JSON.stringify(payload);
        const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

        const req = https.request({
            hostname: "api.razorpay.com",
            path: `/v1/payments/${encodeURIComponent(paymentId)}/refund`,
            method: "POST",
            headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body)
            }
        }, response => {
            let data = "";
            response.on("data", chunk => data += chunk);
            response.on("end", () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    parsed = { error: { description: data } };
                }

                if (response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(parsed);
                } else {
                    const desc = parsed?.error?.description || parsed?.error?.code || `Razorpay error HTTP ${response.statusCode}`;
                    const err = new Error(desc);
                    err.statusCode = response.statusCode;
                    err.isClientError = response.statusCode >= 400 && response.statusCode < 500;
                    err.responseBody = parsed;
                    reject(err);
                }
            });
        });

        req.setTimeout(20000, () => {
            const err = new Error("Razorpay refund request timed out");
            err.isTimeout = true;
            err.isNetworkError = true;
            req.destroy(err);
        });

        req.on("error", err => {
            err.isNetworkError = true;
            reject(err);
        });
        req.write(body);
        req.end();
    });
}

/**
 * Low-level Razorpay API helper to fetch all refunds for a given payment.
 * Used for reconciliation when a refund attempt encountered an uncertain outcome.
 *
 * @param {string} paymentId
 * @returns {Promise<{ entity: string, count: number, items: Array }>}
 */
function razorpayFetchPaymentRefunds(paymentId) {
    return new Promise((resolve, reject) => {
        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;

        if (!keyId || !keySecret) {
            return reject(new Error("Razorpay keys are not configured in .env"));
        }
        if (!paymentId) {
            return reject(new Error("Missing Razorpay payment ID"));
        }

        const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

        const req = https.request({
            hostname: "api.razorpay.com",
            path: `/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
            method: "GET",
            headers: {
                Authorization: `Basic ${auth}`,
                Accept: "application/json"
            }
        }, response => {
            let data = "";
            response.on("data", chunk => data += chunk);
            response.on("end", () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    parsed = { error: { description: data } };
                }

                if (response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(parsed);
                } else {
                    const desc = parsed?.error?.description || parsed?.error?.code || `Razorpay error HTTP ${response.statusCode}`;
                    const err = new Error(desc);
                    err.statusCode = response.statusCode;
                    reject(err);
                }
            });
        });

        req.setTimeout(20000, () => {
            const err = new Error("Razorpay list refunds request timed out");
            err.isTimeout = true;
            err.isNetworkError = true;
            req.destroy(err);
        });

        req.on("error", err => {
            err.isNetworkError = true;
            reject(err);
        });
        req.end();
    });
}

/**
 * Safely cancels an order and restores product stock exactly once (unpaid/direct cancellation).
 *
 * @param {Object} options
 * @param {import('mongodb').Db} options.db - Connected MongoDB Db instance
 * @param {string|ObjectId} options.orderId - Order ID to cancel
 * @param {string|null} [options.userId] - User ID if user-initiated (null for admin)
 * @param {string[]} [options.allowedStatuses] - Explicit statuses that are allowed to be cancelled
 * @returns {Promise<{ success: boolean, code: string, status: number, message: string, order?: Object, restoredItems?: Array }>}
 */
async function cancelOrderSafely({ db, orderId, userId = null, allowedStatuses = null }) {
    if (!ObjectId.isValid(orderId)) {
        return {
            success: false,
            code: "INVALID_ID",
            status: 400,
            message: "Invalid Order ID"
        };
    }

    const validAllowedStatuses = Array.isArray(allowedStatuses) && allowedStatuses.length > 0
        ? allowedStatuses
        : (userId ? ["Pending", "Paid"] : ["Pending", "Paid", "Processing"]);

    const id = new ObjectId(orderId);
    const lookupFilter = { _id: id };
    if (userId) {
        lookupFilter.userID = String(userId);
    }

    const order = await db.collection("orders").findOne(lookupFilter);
    if (!order) {
        return {
            success: false,
            code: "NOT_FOUND",
            status: 404,
            message: "Order Not Found"
        };
    }

    if (order.status === "Cancelled") {
        return {
            success: false,
            code: "ALREADY_CANCELLED",
            status: 400,
            message: "Order is already cancelled"
        };
    }

    if (order.status === "Delivered") {
        return {
            success: false,
            code: "ALREADY_DELIVERED",
            status: 400,
            message: "Delivered orders cannot be cancelled"
        };
    }

    if (!validAllowedStatuses.includes(order.status)) {
        return {
            success: false,
            code: "INVALID_STATUS",
            status: 400,
            message: `Orders with status '${order.status}' cannot be cancelled`
        };
    }

    if (order.stockRestored === true) {
        return {
            success: false,
            code: "STOCK_ALREADY_RESTORED",
            status: 400,
            message: "Stock has already been restored for this order"
        };
    }

    const atomicFilter = {
        _id: id,
        status: { $in: validAllowedStatuses },
        stockRestored: { $ne: true }
    };
    if (userId) {
        atomicFilter.userID = String(userId);
    }

    const updateResult = await db.collection("orders").updateOne(
        atomicFilter,
        {
            $set: {
                status: "Cancelled",
                cancelledAt: new Date(),
                stockRestored: true,
                stockRestoredAt: new Date()
            }
        }
    );

    if (updateResult.modifiedCount !== 1) {
        return {
            success: false,
            code: "CONCURRENT_CANCEL",
            status: 409,
            message: "Order was already cancelled by another request"
        };
    }

    const restoredItems = [];
    const products = Array.isArray(order.products) ? order.products : [];

    for (const item of products) {
        if (!item || !ObjectId.isValid(item.productID)) continue;

        const qty = Math.max(0, Number(item.qty) || 0);
        if (qty <= 0) continue;

        await db.collection("product").updateOne(
            { _id: new ObjectId(item.productID) },
            { $inc: { stock: qty } }
        );

        restoredItems.push({
            productID: item.productID.toString(),
            qty
        });
    }

    sendOrderCancelledCustomerEmail({
        order,
        reason: "Order cancelled",
        customerEmail: order.userEmail || order.shippingAddress?.email,
        customerName: order.userName
    }).catch(err => console.error("Customer cancellation email error:", err));

    sendOrderCancelledAdminEmail({
        order,
        reason: "Order cancelled",
        cancelledBy: userId ? "Customer" : "Admin"
    }).catch(err => console.error("Admin cancellation email error:", err));

    return {
        success: true,
        code: "CANCELLED",
        status: 200,
        message: "Order cancelled successfully",
        order,
        restoredItems
    };
}

/**
 * Customer creates a cancellation request.
 * - For PAID orders: do NOT immediately cancel, do NOT refund, do NOT restore stock.
 *   Mark cancellationStatus as "Pending Approval".
 * - For UNPAID orders: safely cancel and restore stock immediately.
 *
 * @param {Object} options
 * @param {import('mongodb').Db} options.db
 * @param {string|ObjectId} options.orderId
 * @param {string} options.userId
 * @param {string} [options.reason]
 * @returns {Promise<{ success: boolean, code: string, status: number, message: string }>}
 */
async function requestCustomerCancellation({ db, orderId, userId, reason = "" }) {
    if (!ObjectId.isValid(orderId)) {
        return { success: false, code: "INVALID_ID", status: 400, message: "Invalid Order ID" };
    }

    const id = new ObjectId(orderId);
    const order = await db.collection("orders").findOne({ _id: id, userID: String(userId) });
    if (!order) {
        return { success: false, code: "NOT_FOUND", status: 404, message: "Order Not Found" };
    }

    if (order.status === "Cancelled") {
        return { success: false, code: "ALREADY_CANCELLED", status: 400, message: "Order is already cancelled" };
    }
    if (order.status === "Delivered") {
        return { success: false, code: "ALREADY_DELIVERED", status: 400, message: "Delivered orders cannot be cancelled" };
    }
    if (order.status === "Shipped") {
        return { success: false, code: "ALREADY_SHIPPED", status: 400, message: "Orders that have already shipped cannot be cancelled" };
    }

    // Check if cancellation is already requested and pending approval
    if (order.cancellationStatus === "Pending Approval") {
        return {
            success: false,
            code: "ALREADY_REQUESTED",
            status: 400,
            message: "A cancellation request for this order is already pending approval"
        };
    }

    // For UNPAID orders (status: 'Pending' and no paymentId), cancel directly according to safe rules
    if (order.status === "Pending" && !order.paymentId) {
        return cancelOrderSafely({
            db,
            orderId: id,
            userId,
            allowedStatuses: ["Pending"]
        });
    }

    // For PAID orders: do NOT cancel, do NOT refund, do NOT restore stock yet.
    // Atomically transition cancellationStatus to "Pending Approval".
    const result = await db.collection("orders").updateOne(
        {
            _id: id,
            userID: String(userId),
            status: "Paid",
            cancellationStatus: { $ne: "Pending Approval" }
        },
        {
            $set: {
                cancellationStatus: "Pending Approval",
                cancellationRequest: {
                    status: "Pending Approval",
                    reason: String(reason || "Customer requested cancellation").slice(0, 500),
                    requestedAt: new Date()
                }
            }
        }
    );

    if (result.modifiedCount !== 1) {
        return {
            success: false,
            code: "CONCURRENT_REQUEST",
            status: 409,
            message: "A cancellation request has already been submitted for this order"
        };
    }

    return {
        success: true,
        code: "CANCELLATION_REQUESTED",
        status: 200,
        message: "Cancellation request submitted. Waiting for admin approval."
    };
}

/**
 * Admin approves a cancellation request and initiates a FULL refund through Razorpay.
 *
 * @param {Object} options
 * @param {import('mongodb').Db} options.db
 * @param {string|ObjectId} options.orderId
 * @param {string} [options.adminUser]
 * @param {Function} [options.requester] - Optional refund requester (defaults to real Razorpay API)
 * @param {Function} [options.lister] - Optional refund lister (defaults to real Razorpay API)
 * @returns {Promise<{ success: boolean, code: string, status: number, message: string, refund?: Object, restoredItems?: Array }>}
 */
async function approveCancellationAndRefund({ db, orderId, adminUser = "admin", requester = razorpayRefundRequest, lister = razorpayFetchPaymentRefunds }) {
    if (!ObjectId.isValid(orderId)) {
        return { success: false, code: "INVALID_ID", status: 400, message: "Invalid Order ID" };
    }

    const id = new ObjectId(orderId);
    let order = await db.collection("orders").findOne({ _id: id });
    if (!order) {
        return { success: false, code: "NOT_FOUND", status: 404, message: "Order Not Found" };
    }

    if (order.status === "Cancelled") {
        return { success: false, code: "ALREADY_CANCELLED", status: 400, message: "Order is already cancelled" };
    }
    if (order.status === "Delivered") {
        return { success: false, code: "ALREADY_DELIVERED", status: 400, message: "Delivered orders cannot be cancelled or refunded" };
    }
    if (order.refundStatus === "Refunded" || order.refund?.refundId) {
        return { success: false, code: "ALREADY_REFUNDED", status: 400, message: "Order payment has already been refunded" };
    }

    // If previous attempt had an uncertain outcome (e.g. timeout), conclusively reconcile first!
    if (order.refundStatus === "Requires Reconciliation") {
        const recResult = await reconcileOrderRefund({ db, orderId: id, adminUser, lister });
        if (recResult.resolved && recResult.action === "REFUND_CONFIRMED") {
            return {
                success: true,
                code: "APPROVED_AND_REFUNDED",
                status: 200,
                message: "Previous refund was confirmed via Razorpay reconciliation",
                refund: recResult.refund,
                restoredItems: recResult.restoredItems
            };
        }
        if (!recResult.resolved) {
            return {
                success: false,
                code: "REFUND_REQUIRES_RECONCILIATION",
                status: 409,
                message: "Cannot initiate new refund: previous attempt outcome is uncertain and could not be reconciled."
            };
        }
        // If reconciled with NO_REFUND_FOUND, order status in DB was updated to Failed, refresh local order
        order = await db.collection("orders").findOne({ _id: id });
    }

    if (order.cancellationStatus !== "Pending Approval") {
        return { success: false, code: "NOT_PENDING_APPROVAL", status: 400, message: "Order does not have a pending cancellation request" };
    }
    if (!order.paymentId) {
        return { success: false, code: "MISSING_PAYMENT_ID", status: 400, message: "Order does not have a valid payment ID for refund" };
    }

    const internalRefundRef = `ref_${id.toString()}_${Date.now()}`;

    // Atomic refund lock: prevent concurrent approval requests and duplicate refunds!
    const claim = await db.collection("orders").updateOne(
        {
            _id: id,
            status: "Paid",
            cancellationStatus: "Pending Approval",
            refundStatus: { $nin: ["Processing", "Refunded", "Requires Reconciliation"] }
        },
        {
            $set: {
                refundStatus: "Processing",
                internalRefundRef,
                refundLockAt: new Date()
            }
        }
    );

    if (claim.modifiedCount !== 1) {
        return {
            success: false,
            code: "CONCURRENT_APPROVAL",
            status: 409,
            message: "A refund for this order is already being processed or has already completed"
        };
    }

    // Amount MUST come strictly from the verified order total in MongoDB (never from client)
    const totalAmount = Number(order.total) || 0;
    if (totalAmount <= 0) {
        await db.collection("orders").updateOne({ _id: id }, { $unset: { refundStatus: "", refundLockAt: "", internalRefundRef: "" } });
        return { success: false, code: "INVALID_AMOUNT", status: 400, message: "Invalid order amount for refund" };
    }
    const amountPaise = Math.round(totalAmount * 100);

    let refundResponse;
    try {
        refundResponse = await requester(order.paymentId, amountPaise, {
            orderId: id.toString(),
            internalRefundRef,
            reason: "Admin approved cancellation"
        });

        if (!refundResponse || !refundResponse.id) {
            throw new Error("Razorpay returned invalid response without refund ID");
        }
    } catch (refundError) {
        // If Razorpay explicitly rejected the request (HTTP 4xx client error):
        if (isDefinitiveRejection(refundError)) {
            await db.collection("orders").updateOne(
                { _id: id },
                {
                    $set: {
                        refundStatus: "Failed",
                        refundError: refundError.message,
                        refundFailedAt: new Date()
                    },
                    $unset: { refundLockAt: "" }
                }
            );

            return {
                success: false,
                code: "RAZORPAY_REFUND_FAILED",
                status: refundError.statusCode || 400,
                message: `Razorpay refund failed: ${refundError.message}`
            };
        }

        // UNCERTAIN OUTCOME: Request timed out or network disconnected.
        // DO NOT mark as Failed! Mark as 'Requires Reconciliation' so duplicate refund attempts are prevented.
        await db.collection("orders").updateOne(
            { _id: id },
            {
                $set: {
                    refundStatus: "Requires Reconciliation",
                    reconciliationPending: true,
                    reconciliationReason: `Uncertain network outcome: ${refundError.message}`,
                    refundError: `Uncertain network outcome: ${refundError.message}. Verification required.`,
                    reconciliationRequestedAt: new Date()
                },
                $unset: { refundLockAt: "" }
            }
        );

        return {
            success: false,
            code: "REFUND_REQUIRES_RECONCILIATION",
            status: 504,
            message: `Refund request timed out or network disconnected (${refundError.message}). Outcome is uncertain; reconciliation with Razorpay is required.`
        };
    }

    // Razorpay confirmed refund! Save record, mark Cancelled, and restore stock once.
    const refundRecord = {
        refundId: refundResponse.id,
        paymentId: order.paymentId,
        internalRefundRef,
        amount: totalAmount,
        amountPaise: amountPaise,
        currency: refundResponse.currency || "INR",
        status: refundResponse.status || "processed",
        speed: refundResponse.speed_processed || "normal",
        initiatedAt: new Date(),
        rawResponse: {
            id: refundResponse.id,
            entity: refundResponse.entity,
            amount: refundResponse.amount,
            status: refundResponse.status
        }
    };

    await db.collection("orders").updateOne(
        { _id: id },
        {
            $set: {
                status: "Cancelled",
                cancellationStatus: "Approved",
                refundStatus: "Refunded",
                refund: refundRecord,
                cancelledAt: new Date(),
                stockRestored: true,
                stockRestoredAt: new Date(),
                "cancellationRequest.status": "Approved",
                "cancellationRequest.reviewedAt": new Date(),
                "cancellationRequest.reviewedBy": String(adminUser || "admin")
            },
            $unset: { refundLockAt: "", refundError: "", reconciliationPending: "", reconciliationReason: "" }
        }
    );

    // Restore stock safely once
    const restoredItems = [];
    for (const item of (order.products || [])) {
        if (!item || !ObjectId.isValid(item.productID)) continue;
        const qty = Math.max(0, Number(item.qty) || 0);
        if (qty <= 0) continue;

        await db.collection("product").updateOne(
            { _id: new ObjectId(item.productID) },
            { $inc: { stock: qty } }
        );
        restoredItems.push({ productID: item.productID.toString(), qty });
    }

    // Asynchronously dispatch Customer & Admin Refund/Cancellation Emails
    sendRefundCustomerEmail({
        order,
        refund: refundRecord,
        customerEmail: order.userEmail || order.shippingAddress?.email,
        customerName: order.userName
    }).catch(err => console.error("Customer refund email error:", err));

    sendOrderCancelledCustomerEmail({
        order,
        reason: "Admin approved cancellation",
        refund: refundRecord,
        customerEmail: order.userEmail || order.shippingAddress?.email,
        customerName: order.userName
    }).catch(err => console.error("Customer cancellation email error:", err));

    sendRefundAdminEmail({
        order,
        refund: refundRecord,
        approvedBy: adminUser
    }).catch(err => console.error("Admin refund email error:", err));

    sendOrderCancelledAdminEmail({
        order,
        reason: "Admin approved cancellation",
        cancelledBy: adminUser
    }).catch(err => console.error("Admin cancellation email error:", err));

    return {
        success: true,
        code: "APPROVED_AND_REFUNDED",
        status: 200,
        message: "Cancellation approved and full refund processed successfully",
        refund: refundRecord,
        restoredItems
    };
}

/**
 * Admin rejects a customer's cancellation request.
 * Order remains active, stock remains unchanged.
 *
 * @param {Object} options
 * @param {import('mongodb').Db} options.db
 * @param {string|ObjectId} options.orderId
 * @param {string} [options.adminUser]
 * @param {string} [options.reason]
 * @returns {Promise<{ success: boolean, code: string, status: number, message: string }>}
 */
async function rejectCancellationRequest({ db, orderId, adminUser = "admin", reason = "Cancellation request rejected" }) {
    if (!ObjectId.isValid(orderId)) {
        return { success: false, code: "INVALID_ID", status: 400, message: "Invalid Order ID" };
    }

    const id = new ObjectId(orderId);
    const order = await db.collection("orders").findOne({ _id: id });
    if (!order) {
        return { success: false, code: "NOT_FOUND", status: 404, message: "Order Not Found" };
    }

    if (order.status === "Cancelled") {
        return { success: false, code: "ALREADY_CANCELLED", status: 400, message: "Order is already cancelled" };
    }
    if (order.cancellationStatus !== "Pending Approval") {
        return { success: false, code: "NOT_PENDING_APPROVAL", status: 400, message: "Order does not have a pending cancellation request" };
    }

    const result = await db.collection("orders").updateOne(
        {
            _id: id,
            cancellationStatus: "Pending Approval"
        },
        {
            $set: {
                cancellationStatus: "Rejected",
                "cancellationRequest.status": "Rejected",
                "cancellationRequest.reviewedAt": new Date(),
                "cancellationRequest.reviewedBy": String(adminUser || "admin"),
                "cancellationRequest.rejectionReason": String(reason || "Cancellation request rejected by administrator").slice(0, 500)
            }
        }
    );

    if (result.modifiedCount !== 1) {
        return {
            success: false,
            code: "CONCURRENT_REJECT",
            status: 409,
            message: "Cancellation request was already reviewed by another request"
        };
    }

    return {
        success: true,
        code: "REJECTED",
        status: 200,
        message: "Cancellation request rejected successfully. Order remains active."
    };
}

/**
 * Admin direct cancellation:
 * - For PAID orders: initiates FULL refund through Razorpay, then marks Cancelled & restores stock once.
 * - For UNPAID orders: safe cancellation with stock restoration once.
 *
 * @param {Object} options
 * @param {import('mongodb').Db} options.db
 * @param {string|ObjectId} options.orderId
 * @param {string} [options.adminUser]
 * @param {Function} [options.requester]
 * @param {Function} [options.lister]
 * @returns {Promise<{ success: boolean, code: string, status: number, message: string, refund?: Object, restoredItems?: Array }>}
 */
async function adminDirectCancelOrder({ db, orderId, adminUser = "admin", requester = razorpayRefundRequest, lister = razorpayFetchPaymentRefunds }) {
    if (!ObjectId.isValid(orderId)) {
        return { success: false, code: "INVALID_ID", status: 400, message: "Invalid Order ID" };
    }

    const id = new ObjectId(orderId);
    let order = await db.collection("orders").findOne({ _id: id });
    if (!order) {
        return { success: false, code: "NOT_FOUND", status: 404, message: "Order Not Found" };
    }

    if (order.status === "Cancelled") {
        return { success: false, code: "ALREADY_CANCELLED", status: 400, message: "Order is already cancelled" };
    }
    if (order.status === "Delivered") {
        return { success: false, code: "ALREADY_DELIVERED", status: 400, message: "Delivered orders cannot be cancelled" };
    }

    // UNPAID order (no paymentId or not Paid): follow safe existing cancellation rules
    if (!order.paymentId || order.status !== "Paid") {
        return cancelOrderSafely({
            db,
            orderId: id,
            userId: null,
            allowedStatuses: ["Pending", "Paid", "Processing"]
        });
    }

    // PAID order: Full refund through Razorpay is mandatory
    if (order.refundStatus === "Refunded" || order.refund?.refundId) {
        return { success: false, code: "ALREADY_REFUNDED", status: 400, message: "Order payment has already been refunded" };
    }

    // If previous attempt had an uncertain outcome, reconcile first!
    if (order.refundStatus === "Requires Reconciliation") {
        const recResult = await reconcileOrderRefund({ db, orderId: id, adminUser, lister });
        if (recResult.resolved && recResult.action === "REFUND_CONFIRMED") {
            return {
                success: true,
                code: "CANCELLED_AND_REFUNDED",
                status: 200,
                message: "Previous refund was confirmed via Razorpay reconciliation",
                refund: recResult.refund,
                restoredItems: recResult.restoredItems
            };
        }
        if (!recResult.resolved) {
            return {
                success: false,
                code: "REFUND_REQUIRES_RECONCILIATION",
                status: 409,
                message: "Cannot initiate new refund: previous attempt outcome is uncertain and could not be reconciled."
            };
        }
        order = await db.collection("orders").findOne({ _id: id });
    }

    const internalRefundRef = `ref_${id.toString()}_${Date.now()}`;

    const claim = await db.collection("orders").updateOne(
        {
            _id: id,
            status: "Paid",
            refundStatus: { $nin: ["Processing", "Refunded", "Requires Reconciliation"] }
        },
        {
            $set: {
                refundStatus: "Processing",
                internalRefundRef,
                refundLockAt: new Date()
            }
        }
    );

    if (claim.modifiedCount !== 1) {
        return {
            success: false,
            code: "CONCURRENT_CANCEL",
            status: 409,
            message: "A refund or cancellation for this order is already in progress"
        };
    }

    const totalAmount = Number(order.total) || 0;
    const amountPaise = Math.round(totalAmount * 100);

    let refundResponse;
    try {
        refundResponse = await requester(order.paymentId, amountPaise, {
            orderId: id.toString(),
            internalRefundRef,
            reason: "Admin direct cancellation and refund"
        });

        if (!refundResponse || !refundResponse.id) {
            throw new Error("Razorpay returned invalid response without refund ID");
        }
    } catch (refundError) {
        if (isDefinitiveRejection(refundError)) {
            await db.collection("orders").updateOne(
                { _id: id },
                {
                    $set: {
                        refundStatus: "Failed",
                        refundError: refundError.message,
                        refundFailedAt: new Date()
                    },
                    $unset: { refundLockAt: "" }
                }
            );

            return {
                success: false,
                code: "RAZORPAY_REFUND_FAILED",
                status: refundError.statusCode || 400,
                message: `Razorpay refund failed: ${refundError.message}`
            };
        }

        // Uncertain network outcome: do NOT mark Failed!
        await db.collection("orders").updateOne(
            { _id: id },
            {
                $set: {
                    refundStatus: "Requires Reconciliation",
                    reconciliationPending: true,
                    reconciliationReason: `Uncertain network outcome: ${refundError.message}`,
                    refundError: `Uncertain network outcome: ${refundError.message}. Verification required.`,
                    reconciliationRequestedAt: new Date()
                },
                $unset: { refundLockAt: "" }
            }
        );

        return {
            success: false,
            code: "REFUND_REQUIRES_RECONCILIATION",
            status: 504,
            message: `Refund request timed out or network disconnected (${refundError.message}). Outcome is uncertain; reconciliation with Razorpay is required.`
        };
    }

    const refundRecord = {
        refundId: refundResponse.id,
        paymentId: order.paymentId,
        internalRefundRef,
        amount: totalAmount,
        amountPaise: amountPaise,
        currency: refundResponse.currency || "INR",
        status: refundResponse.status || "processed",
        speed: refundResponse.speed_processed || "normal",
        initiatedAt: new Date(),
        rawResponse: {
            id: refundResponse.id,
            entity: refundResponse.entity,
            amount: refundResponse.amount,
            status: refundResponse.status
        }
    };

    await db.collection("orders").updateOne(
        { _id: id },
        {
            $set: {
                status: "Cancelled",
                cancellationStatus: "Approved",
                refundStatus: "Refunded",
                refund: refundRecord,
                cancelledAt: new Date(),
                stockRestored: true,
                stockRestoredAt: new Date(),
                directCancelledBy: String(adminUser || "admin")
            },
            $unset: { refundLockAt: "", refundError: "", reconciliationPending: "", reconciliationReason: "" }
        }
    );

    const restoredItems = [];
    for (const item of (order.products || [])) {
        if (!item || !ObjectId.isValid(item.productID)) continue;
        const qty = Math.max(0, Number(item.qty) || 0);
        if (qty <= 0) continue;

        await db.collection("product").updateOne(
            { _id: new ObjectId(item.productID) },
            { $inc: { stock: qty } }
        );
        restoredItems.push({ productID: item.productID.toString(), qty });
    }

    // Asynchronously dispatch Customer & Admin Refund/Cancellation Emails
    sendRefundCustomerEmail({
        order,
        refund: refundRecord,
        customerEmail: order.userEmail || order.shippingAddress?.email,
        customerName: order.userName
    }).catch(err => console.error("Customer refund email error:", err));

    sendOrderCancelledCustomerEmail({
        order,
        reason: "Direct cancellation by administrator",
        refund: refundRecord,
        customerEmail: order.userEmail || order.shippingAddress?.email,
        customerName: order.userName
    }).catch(err => console.error("Customer cancellation email error:", err));

    sendRefundAdminEmail({
        order,
        refund: refundRecord,
        approvedBy: adminUser
    }).catch(err => console.error("Admin refund email error:", err));

    sendOrderCancelledAdminEmail({
        order,
        reason: "Direct cancellation by administrator",
        cancelledBy: adminUser
    }).catch(err => console.error("Admin cancellation email error:", err));

    return {
        success: true,
        code: "CANCELLED_AND_REFUNDED",
        status: 200,
        message: "Order cancelled and full refund processed successfully",
        refund: refundRecord,
        restoredItems
    };
}

/**
 * Conclusively reconciles an uncertain refund attempt with Razorpay using the payment's refund list.
 *
 * @param {Object} options
 * @param {import('mongodb').Db} options.db
 * @param {string|ObjectId} options.orderId
 * @param {string} [options.adminUser]
 * @param {Function} [options.lister]
 * @returns {Promise<{ success: boolean, resolved: boolean, action: string, code: string, status: number, message: string, refund?: Object, restoredItems?: Array, order?: Object }>}
 */
async function reconcileOrderRefund({ db, orderId, adminUser = "admin", lister = razorpayFetchPaymentRefunds }) {
    if (!ObjectId.isValid(orderId)) {
        return { success: false, resolved: false, code: "INVALID_ID", status: 400, message: "Invalid Order ID" };
    }

    const id = new ObjectId(orderId);
    const order = await db.collection("orders").findOne({ _id: id });
    if (!order) {
        return { success: false, resolved: false, code: "NOT_FOUND", status: 404, message: "Order Not Found" };
    }

    // Already completed refund
    if (order.status === "Cancelled" && order.refundStatus === "Refunded" && order.refund?.refundId) {
        return {
            success: true,
            resolved: true,
            action: "ALREADY_REFUNDED",
            code: "ALREADY_REFUNDED",
            status: 200,
            message: "Order is already cancelled and refunded",
            refund: order.refund
        };
    }

    if (!order.paymentId) {
        return {
            success: false,
            resolved: false,
            code: "MISSING_PAYMENT_ID",
            status: 400,
            message: "Cannot reconcile order without a payment ID"
        };
    }

    let refundList;
    try {
        refundList = await lister(order.paymentId);
    } catch (listerErr) {
        return {
            success: false,
            resolved: false,
            code: "RECONCILIATION_NETWORK_ERROR",
            status: 502,
            message: `Unable to fetch refund list from Razorpay: ${listerErr.message}`
        };
    }

    const items = Array.isArray(refundList?.items) ? refundList.items : [];
    const expectedPaise = Math.round((Number(order.total) || 0) * 100);

    // Look for matching refund for this order/payment
    const matchingRefund = items.find(item => {
        if (!item || item.status === "failed") return false;
        if (order.internalRefundRef && item.notes?.internalRefundRef === order.internalRefundRef) return true;
        if (item.notes?.orderId === id.toString()) return true;
        if (item.payment_id === order.paymentId && Number(item.amount) === expectedPaise) return true;
        return false;
    });

    if (matchingRefund) {
        // Previous refund attempt was captured and created by Razorpay before timeout!
        const totalAmount = Number(order.total) || (Number(matchingRefund.amount) / 100);
        const refundRecord = {
            refundId: matchingRefund.id,
            paymentId: order.paymentId,
            internalRefundRef: order.internalRefundRef || matchingRefund.notes?.internalRefundRef || "",
            amount: totalAmount,
            amountPaise: matchingRefund.amount,
            currency: matchingRefund.currency || "INR",
            status: matchingRefund.status || "processed",
            speed: matchingRefund.speed_processed || "normal",
            initiatedAt: new Date(matchingRefund.created_at ? matchingRefund.created_at * 1000 : Date.now()),
            reconciledAt: new Date(),
            reconciledBy: String(adminUser || "admin"),
            rawResponse: matchingRefund
        };

        await db.collection("orders").updateOne(
            { _id: id },
            {
                $set: {
                    status: "Cancelled",
                    cancellationStatus: "Approved",
                    refundStatus: "Refunded",
                    refund: refundRecord,
                    cancelledAt: order.cancelledAt || new Date(),
                    stockRestored: true,
                    stockRestoredAt: order.stockRestoredAt || new Date(),
                    reconciliationPending: false,
                    reconciledAt: new Date()
                },
                $unset: { refundLockAt: "", refundError: "", reconciliationReason: "" }
            }
        );

        // Restore stock safely once if not already restored
        const restoredItems = [];
        if (order.stockRestored !== true) {
            for (const item of (order.products || [])) {
                if (!item || !ObjectId.isValid(item.productID)) continue;
                const qty = Math.max(0, Number(item.qty) || 0);
                if (qty <= 0) continue;

                await db.collection("product").updateOne(
                    { _id: new ObjectId(item.productID) },
                    { $inc: { stock: qty } }
                );
                restoredItems.push({ productID: item.productID.toString(), qty });
            }
        }

        return {
            success: true,
            resolved: true,
            action: "REFUND_CONFIRMED",
            code: "RECONCILED_AND_REFUNDED",
            status: 200,
            message: "Reconciliation confirmed Razorpay refund. Order cancelled and stock restored.",
            refund: refundRecord,
            restoredItems
        };
    }

    // Conclusive proof from Razorpay that NO refund was created!
    await db.collection("orders").updateOne(
        { _id: id },
        {
            $set: {
                refundStatus: "Failed",
                reconciliationPending: false,
                reconciledAt: new Date(),
                refundError: "Reconciliation conclusively confirmed no refund was recorded on Razorpay."
            },
            $unset: { refundLockAt: "", reconciliationReason: "" }
        }
    );

    return {
        success: true,
        resolved: true,
        action: "NO_REFUND_FOUND",
        code: "RECONCILED_NO_REFUND",
        status: 200,
        message: "Reconciliation confirmed no refund was created on Razorpay. Status updated to Failed.",
        order: { ...order, refundStatus: "Failed" }
    };
}

/**
 * Handles incoming verified Razorpay webhooks (e.g. refund.processed, refund.failed).
 * Enforces strict idempotency, correct order ownership, and single stock restoration.
 *
 * @param {Object} options
 * @param {import('mongodb').Db} options.db
 * @param {Object} options.event
 * @returns {Promise<{ success: boolean, status: number, message: string, idempotent?: boolean, refund?: Object }>}
 */
async function processRazorpayWebhook({ db, event }) {
    if (!event || !event.event) {
        return { success: false, status: 400, message: "Invalid webhook event payload" };
    }

    const eventType = event.event;
    if (eventType !== "refund.processed" && eventType !== "refund.failed") {
        return { success: true, status: 200, message: `Event '${eventType}' acknowledged and ignored` };
    }

    const refundEntity = event.payload?.refund?.entity;
    if (!refundEntity || !refundEntity.id) {
        return { success: false, status: 400, message: "Missing refund entity in webhook payload" };
    }

    const refundId = refundEntity.id;
    const paymentId = refundEntity.payment_id;
    const orderIdNote = refundEntity.notes?.orderId;

    // Locate the matching order
    const filter = {
        $or: [
            { "refund.refundId": refundId },
            { paymentId: paymentId }
        ]
    };
    if (orderIdNote && ObjectId.isValid(orderIdNote)) {
        filter.$or.unshift({ _id: new ObjectId(orderIdNote) });
    }

    const order = await db.collection("orders").findOne(filter);
    if (!order) {
        return {
            success: false,
            status: 404,
            message: `No order found matching payment '${paymentId}' or refund '${refundId}'`
        };
    }

    // Check if event was already processed (Idempotency)
    const eventId = event.id || `${eventType}_${refundId}`;
    if (Array.isArray(order.processedWebhooks) && order.processedWebhooks.includes(eventId)) {
        return {
            success: true,
            status: 200,
            idempotent: true,
            message: "Webhook event already processed"
        };
    }

    if (eventType === "refund.processed") {
        // If already marked Refunded and stock is restored, just register the event idempotently
        if (order.status === "Cancelled" && order.refundStatus === "Refunded" && order.stockRestored === true) {
            await db.collection("orders").updateOne(
                { _id: order._id },
                { $addToSet: { processedWebhooks: eventId } }
            );
            return {
                success: true,
                status: 200,
                idempotent: true,
                message: "Order already refunded and cancelled (idempotent)"
            };
        }

        const totalAmount = Number(order.total) || (Number(refundEntity.amount) / 100);
        const amountPaise = Number(refundEntity.amount) || Math.round(totalAmount * 100);

        const refundRecord = {
            refundId: refundEntity.id,
            paymentId: order.paymentId || refundEntity.payment_id,
            amount: totalAmount,
            amountPaise: amountPaise,
            currency: refundEntity.currency || "INR",
            status: refundEntity.status || "processed",
            speed: refundEntity.speed_processed || "normal",
            initiatedAt: new Date(refundEntity.created_at ? refundEntity.created_at * 1000 : Date.now()),
            webhookProcessedAt: new Date(),
            rawResponse: refundEntity
        };

        // Atomically update order to Cancelled and Refunded
        const updateResult = await db.collection("orders").updateOne(
            {
                _id: order._id,
                refundStatus: { $ne: "Refunded" }
            },
            {
                $set: {
                    status: "Cancelled",
                    cancellationStatus: "Approved",
                    refundStatus: "Refunded",
                    refund: refundRecord,
                    cancelledAt: order.cancelledAt || new Date(),
                    stockRestored: true,
                    stockRestoredAt: order.stockRestoredAt || new Date(),
                    webhookProcessed: true,
                    webhookProcessedAt: new Date()
                },
                $addToSet: { processedWebhooks: eventId },
                $unset: { refundLockAt: "", refundError: "", reconciliationPending: "", reconciliationReason: "" }
            }
        );

        // Restore stock strictly ONCE
        if (updateResult.modifiedCount === 1 && order.stockRestored !== true) {
            for (const item of (order.products || [])) {
                if (!item || !ObjectId.isValid(item.productID)) continue;
                const qty = Math.max(0, Number(item.qty) || 0);
                if (qty <= 0) continue;
                await db.collection("product").updateOne(
                    { _id: new ObjectId(item.productID) },
                    { $inc: { stock: qty } }
                );
            }
        }

        return {
            success: true,
            status: 200,
            message: "Refund processed successfully via webhook",
            refund: refundRecord
        };
    }

    if (eventType === "refund.failed") {
        if (order.status === "Cancelled" && order.refundStatus === "Refunded") {
            return {
                success: false,
                status: 409,
                message: "Cannot mark a completed refund as failed"
            };
        }

        await db.collection("orders").updateOne(
            {
                _id: order._id,
                refundStatus: { $ne: "Refunded" }
            },
            {
                $set: {
                    refundStatus: "Failed",
                    refundError: refundEntity.error_description || "Refund failed according to Razorpay webhook",
                    refundFailedAt: new Date(),
                    webhookProcessed: true,
                    webhookProcessedAt: new Date()
                },
                $addToSet: { processedWebhooks: eventId },
                $unset: { refundLockAt: "", reconciliationPending: "" }
            }
        );

        return {
            success: true,
            status: 200,
            message: "Refund failure recorded via webhook"
        };
    }
}

module.exports = {
    cancelOrderSafely,
    requestCustomerCancellation,
    approveCancellationAndRefund,
    rejectCancellationRequest,
    adminDirectCancelOrder,
    reconcileOrderRefund,
    processRazorpayWebhook,
    razorpayRefundRequest,
    razorpayFetchPaymentRefunds,
    isDefinitiveRejection,
    isApiRequest
};
