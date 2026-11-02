const { ObjectId } = require("mongodb");

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
 * Safely cancels an order and restores product stock exactly once.
 *
 * Business Rules & Verification Guarantees:
 * 1. Checks current order status in the database before restoring stock.
 * 2. Only cancellable orders (Pending, Paid; or Processing for admin) can be cancelled.
 * 3. An already Cancelled order cannot be cancelled again via UI, direct POST, or API request.
 * 4. Delivered orders cannot be cancelled.
 * 5. Stock restoration and status transition are bound atomically to guarantee stock is restored ONLY ONCE,
 *    even under extreme concurrent/parallel requests.
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

    // 1. Backend checks the current order status before restoring stock
    const order = await db.collection("orders").findOne(lookupFilter);
    if (!order) {
        return {
            success: false,
            code: "NOT_FOUND",
            status: 404,
            message: "Order Not Found"
        };
    }

    // 2. A cancelled order cannot be cancelled again
    if (order.status === "Cancelled") {
        return {
            success: false,
            code: "ALREADY_CANCELLED",
            status: 400,
            message: "Order is already cancelled"
        };
    }

    // 3. Delivered orders cannot be cancelled
    if (order.status === "Delivered") {
        return {
            success: false,
            code: "ALREADY_DELIVERED",
            status: 400,
            message: "Delivered orders cannot be cancelled"
        };
    }

    // 4. Validate cancellable business status (Paid, Pending)
    if (!validAllowedStatuses.includes(order.status)) {
        return {
            success: false,
            code: "INVALID_STATUS",
            status: 400,
            message: `Orders with status '${order.status}' cannot be cancelled`
        };
    }

    // 5. Ensure stock was not already restored
    if (order.stockRestored === true) {
        return {
            success: false,
            code: "STOCK_ALREADY_RESTORED",
            status: 400,
            message: "Stock has already been restored for this order"
        };
    }

    // 6. Safe atomic transition to prevent race conditions and duplicate restorations
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

    // If another concurrent request already transitioned this order, modifiedCount will be 0
    if (updateResult.modifiedCount !== 1) {
        return {
            success: false,
            code: "CONCURRENT_CANCEL",
            status: 409,
            message: "Order was already cancelled by another request"
        };
    }

    // 7. Stock restoration executed ONLY ONCE by the single winning request
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

    return {
        success: true,
        code: "CANCELLED",
        status: 200,
        message: "Order cancelled successfully",
        order,
        restoredItems
    };
}

module.exports = {
    cancelOrderSafely,
    isApiRequest
};
