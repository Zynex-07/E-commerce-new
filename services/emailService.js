const nodemailer = require("nodemailer");

/**
 * Creates a Gmail SMTP transporter using Nodemailer.
 * Reads credentials strictly from server environment variables.
 *
 * @returns {import('nodemailer').Transporter|null}
 */
function createTransporter() {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!user || !pass) {
        return null;
    }

    const host = process.env.EMAIL_HOST || "smtp.gmail.com";
    const port = Number(process.env.EMAIL_PORT) || 465;

    return nodemailer.createTransport({
        service: "gmail",
        host,
        port,
        secure: port === 465,
        auth: {
            user,
            pass
        }
    });
}

/**
 * Diagnostic helper: Verifies the Gmail SMTP transporter connection.
 * Returns safe diagnostic info without exposing credentials.
 *
 * @param {Object} [transporterOverride=null]
 * @returns {Promise<{ ok: boolean, configured: boolean, host: string, port: number, userMasked: string, message: string, code?: string }>}
 */
async function verifySmtpConnection(transporterOverride = null) {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    const host = process.env.EMAIL_HOST || "smtp.gmail.com";
    const port = Number(process.env.EMAIL_PORT) || 465;

    if (!user || !pass) {
        return {
            ok: false,
            configured: false,
            host,
            port,
            userMasked: "Not configured",
            message: "EMAIL_USER or EMAIL_PASS environment variables are missing."
        };
    }

    const maskedUser = user.length > 5 ? `${user.slice(0, 3)}***@${user.split("@")[1] || "gmail.com"}` : "***@gmail.com";
    const transporter = transporterOverride || createTransporter();

    if (!transporter) {
        return {
            ok: false,
            configured: false,
            host,
            port,
            userMasked: maskedUser,
            message: "Unable to initialize Nodemailer transporter."
        };
    }

    try {
        await transporter.verify();
        return {
            ok: true,
            configured: true,
            host,
            port,
            userMasked: maskedUser,
            message: "Gmail SMTP server connection verified successfully."
        };
    } catch (err) {
        return {
            ok: false,
            configured: true,
            host,
            port,
            userMasked: maskedUser,
            message: `SMTP Connection Error: ${err.message}`,
            code: err.code || "ESOCKET"
        };
    }
}

/**
 * Base email dispatcher.
 * Handles simulation if SMTP credentials are not yet configured in .env.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text fallback
 * @param {Object} [options.transporterOverride] - Injected transporter for tests
 * @returns {Promise<{ success: boolean, simulated?: boolean, messageId?: string, error?: string }>}
 */
async function sendEmail({ to, subject, html, text = "", transporterOverride = null }) {
    if (!to || !subject) {
        return { success: false, error: "Missing required email fields (to or subject)" };
    }

    const transporter = transporterOverride || createTransporter();
    const from = process.env.EMAIL_FROM || `"AAK Clothing" <${process.env.EMAIL_USER || "no-reply@aakclothing.com"}>`;

    if (!transporter) {
        console.log(`[Gmail SMTP] (SIMULATED): Sent email to '${to}' | Subject: '${subject}'`);
        return {
            success: true,
            simulated: true,
            messageId: `sim_${Date.now()}`
        };
    }

    try {
        const info = await transporter.sendMail({
            from,
            to,
            subject,
            html,
            text: text || subject
        });

        return {
            success: true,
            simulated: false,
            messageId: info.messageId
        };
    } catch (err) {
        console.error(`[Gmail SMTP Error]: Failed to send email to '${to}':`, err.message);
        return {
            success: false,
            error: err.message
        };
    }
}

/**
 * Helper to generate consistent AAK Clothing branded email wrapper.
 */
function emailShell({ title, kicker, contentHtml, footerNote = "" }) {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <div style="max-width:640px;margin:30px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.06);border:1px solid #e5e7eb;">
        <!-- Header -->
        <div style="background:#111827;padding:24px 32px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:800;letter-spacing:1px;">AAK CLOTHING</h1>
            <p style="margin:4px 0 0;color:#9ca3af;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Style That Fits Your Everyday</p>
        </div>
        <!-- Banner / Kicker -->
        ${kicker ? `<div style="background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:12px 32px;font-size:12px;font-weight:700;color:#4b5563;text-transform:uppercase;letter-spacing:0.5px;">${kicker}</div>` : ""}
        <!-- Body Content -->
        <div style="padding:32px;">
            <h2 style="margin:0 0 16px;color:#111827;font-size:20px;font-weight:700;">${title}</h2>
            ${contentHtml}
        </div>
        <!-- Footer -->
        <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 32px;text-align:center;font-size:12px;color:#6b7280;line-height:1.5;">
            ${footerNote ? `<p style="margin:0 0 8px;">${footerNote}</p>` : ""}
            <p style="margin:0;">© ${new Date().getFullYear()} AAK Clothing. All rights reserved.</p>
            <p style="margin:4px 0 0;">This email was sent regarding your activity on AAK Clothing.</p>
        </div>
    </div>
</body>
</html>`;
}

// ==========================================
// CUSTOMER NOTIFICATIONS
// ==========================================

/**
 * 1. Customer: New Order Confirmation
 */
async function sendNewOrderCustomerEmail({ order, customerEmail, customerName = "Customer", transporterOverride = null }) {
    const to = customerEmail || order.userEmail || order.shippingAddress?.email;
    if (!to) return { success: false, error: "No customer email available" };

    const itemsHtml = (order.products || []).map(item => `
        <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:12px 0;">
                <div style="font-weight:600;color:#111827;">${item.name || "Product"}</div>
                <div style="font-size:12px;color:#6b7280;">Qty: ${item.qty}</div>
            </td>
            <td style="padding:12px 0;text-align:right;font-weight:600;color:#111827;">
                ₹${Number(item.price || item.total || 0).toLocaleString()}
            </td>
        </tr>
    `).join("");

    const contentHtml = `
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Hello <strong>${customerName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Thank you for shopping with AAK Clothing! Your order has been placed successfully and is being prepared.</p>
        
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:24px;">
            <div style="font-size:13px;color:#6b7280;">Order ID: <strong style="color:#111827;font-family:monospace;">${order._id}</strong></div>
            <div style="font-size:13px;color:#6b7280;margin-top:4px;">Payment ID: <strong style="color:#111827;font-family:monospace;">${order.paymentId || "Razorpay"}</strong></div>
            <div style="font-size:13px;color:#6b7280;margin-top:4px;">Payment Status: <span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px;">PAID</span></div>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            <thead>
                <tr style="border-bottom:2px solid #e5e7eb;font-size:12px;color:#6b7280;text-transform:uppercase;">
                    <th style="text-align:left;padding-bottom:8px;">Item</th>
                    <th style="text-align:right;padding-bottom:8px;">Price</th>
                </tr>
            </thead>
            <tbody>
                ${itemsHtml}
            </tbody>
            <tfoot>
                <tr>
                    <td style="padding-top:16px;font-weight:700;font-size:16px;">Total Paid:</td>
                    <td style="padding-top:16px;font-weight:700;font-size:16px;text-align:right;color:#16a34a;">₹${Number(order.total || 0).toLocaleString()}</td>
                </tr>
            </tfoot>
        </table>

        ${order.shippingAddress ? `
        <div style="border-top:1px solid #e5e7eb;padding-top:16px;margin-top:16px;">
            <h4 style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;">Delivery Address</h4>
            <p style="margin:0;font-size:14px;color:#374151;line-height:1.5;">
                ${order.shippingAddress.address || ""}<br>
                ${order.shippingAddress.city || ""}, ${order.shippingAddress.state || ""} - ${order.shippingAddress.pincode || ""}<br>
                Phone: ${order.shippingAddress.mobile || order.shippingAddress.phone || "N/A"}
            </p>
        </div>` : ""}
    `;

    const html = emailShell({
        title: "Order Confirmed!",
        kicker: "Order Confirmation",
        contentHtml,
        footerNote: "You can view your order anytime by visiting your AAK Clothing account."
    });

    return sendEmail({
        to,
        subject: `Order Confirmed: #${String(order._id).slice(-8).toUpperCase()} - AAK Clothing`,
        html,
        transporterOverride
    });
}

/**
 * 2. Customer: Order Status Updates (General)
 */
async function sendOrderStatusUpdateCustomerEmail({ order, newStatus, customerEmail, customerName = "Customer", transporterOverride = null }) {
    const to = customerEmail || order.userEmail || order.shippingAddress?.email;
    if (!to) return { success: false, error: "No customer email available" };

    const contentHtml = `
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Hello <strong>${customerName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">The status of your order <strong>#${String(order._id).slice(-8).toUpperCase()}</strong> has been updated to:</p>
        
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:24px;text-align:center;">
            <div style="font-size:18px;font-weight:800;color:#166534;text-transform:uppercase;">${newStatus}</div>
        </div>

        <p style="margin:0;font-size:14px;color:#6b7280;">Order Total: <strong>₹${order.total}</strong> | Items: <strong>${(order.products || []).length}</strong></p>
    `;

    const html = emailShell({
        title: `Order Status: ${newStatus}`,
        kicker: "Order Update",
        contentHtml
    });

    return sendEmail({
        to,
        subject: `Order Update: #${String(order._id).slice(-8).toUpperCase()} is now ${newStatus} - AAK Clothing`,
        html,
        transporterOverride
    });
}

/**
 * 3. Customer: Order Shipped
 */
async function sendOrderShippedCustomerEmail({ order, trackingInfo = {}, trackingNumber, carrier, customerEmail, customerName = "Customer", transporterOverride = null }) {
    const to = customerEmail || order.userEmail || order.shippingAddress?.email;
    if (!to) return { success: false, error: "No customer email available" };

    const courierPartner = trackingInfo.courier || carrier || "Blue Dart / Delhivery";
    const resolvedTracking = trackingInfo.trackingNumber || trackingNumber || "Assigned on dispatch";
    const deliveryEta = trackingInfo.estimatedDelivery || "3–5 Business Days";

    const contentHtml = `
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Hello <strong>${customerName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Great news! Your AAK Clothing order <strong>#${String(order._id).slice(-8).toUpperCase()}</strong> has been handed over to our courier partner and is on its way to you.</p>

        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin-bottom:24px;">
            <div style="font-size:13px;color:#1e40af;">Courier Partner: <strong>${courierPartner}</strong></div>
            <div style="font-size:13px;color:#1e40af;margin-top:4px;">Tracking Number: <strong>${resolvedTracking}</strong></div>
            <div style="font-size:13px;color:#1e40af;margin-top:4px;">Estimated Delivery: <strong>${deliveryEta}</strong></div>
        </div>

        <p style="margin:0;font-size:14px;color:#4b5563;">Please keep your phone handy to receive calls from the delivery partner upon arrival.</p>
    `;

    const html = emailShell({
        title: "Your Order is on the Way!",
        kicker: "Order Shipped",
        contentHtml
    });

    return sendEmail({
        to,
        subject: `Order Shipped: #${String(order._id).slice(-8).toUpperCase()} is on its way! - AAK Clothing`,
        html,
        transporterOverride
    });
}

/**
 * 4. Customer: Order Delivered
 */
async function sendOrderDeliveredCustomerEmail({ order, customerEmail, customerName = "Customer", transporterOverride = null }) {
    const to = customerEmail || order.userEmail || order.shippingAddress?.email;
    if (!to) return { success: false, error: "No customer email available" };

    const contentHtml = `
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Hello <strong>${customerName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Your package for order <strong>#${String(order._id).slice(-8).toUpperCase()}</strong> has been successfully delivered. We hope you love your new clothes!</p>

        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
            <div style="font-size:24px;">📦 ✨</div>
            <div style="font-size:16px;font-weight:700;color:#065f46;margin-top:8px;">Delivered Successfully</div>
        </div>

        <p style="margin:0;font-size:14px;color:#4b5563;">Loved your items? Log in to your AAK Clothing account to rate your products and write a review.</p>
    `;

    const html = emailShell({
        title: "Order Delivered!",
        kicker: "Delivery Confirmation",
        contentHtml
    });

    return sendEmail({
        to,
        subject: `Order Delivered: #${String(order._id).slice(-8).toUpperCase()} - AAK Clothing`,
        html,
        transporterOverride
    });
}

/**
 * 5. Customer: Order Cancelled
 */
async function sendOrderCancelledCustomerEmail({ order, reason = "Order cancelled", refund = null, customerEmail, customerName = "Customer", transporterOverride = null }) {
    const to = customerEmail || order.userEmail || order.shippingAddress?.email;
    if (!to) return { success: false, error: "No customer email available" };

    const contentHtml = `
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Hello <strong>${customerName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Your order <strong>#${String(order._id).slice(-8).toUpperCase()}</strong> has been cancelled.</p>

        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-bottom:24px;">
            <div style="font-size:13px;color:#991b1b;">Reason: <strong>${reason}</strong></div>
            ${refund ? `
            <div style="font-size:13px;color:#166534;margin-top:8px;">
                ✓ A full refund of <strong>₹${refund.amount || order.total}</strong> has been processed to your original payment method (Razorpay Refund ID: <code>${refund.refundId}</code>). It usually takes 5–7 business days to reflect in your bank account.
            </div>` : ""}
        </div>
    `;

    const html = emailShell({
        title: "Order Cancelled",
        kicker: "Cancellation Notice",
        contentHtml
    });

    return sendEmail({
        to,
        subject: `Order Cancelled: #${String(order._id).slice(-8).toUpperCase()} - AAK Clothing`,
        html,
        transporterOverride
    });
}

/**
 * 6. Customer: Refund Initiated / Completed
 */
async function sendRefundCustomerEmail({ order, refund, refundAmount, refundId, paymentId, customerEmail, customerName = "Customer", transporterOverride = null }) {
    const to = customerEmail || order.userEmail || order.shippingAddress?.email;
    if (!to) return { success: false, error: "No customer email available" };

    const resolvedRefund = {
        refundId: refund?.refundId || refundId || order.refundId || "N/A",
        paymentId: refund?.paymentId || paymentId || order.paymentId || "N/A",
        amount: refund?.amount ?? (refundAmount !== undefined ? refundAmount : order.total)
    };

    const contentHtml = `
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Hello <strong>${customerName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">A full refund for your order <strong>#${String(order._id).slice(-8).toUpperCase()}</strong> has been successfully processed through Razorpay.</p>

        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin-bottom:24px;">
            <div style="font-size:13px;color:#166534;">Refund ID: <strong style="font-family:monospace;">${resolvedRefund.refundId}</strong></div>
            <div style="font-size:13px;color:#166534;margin-top:6px;">Original Payment ID: <strong style="font-family:monospace;">${resolvedRefund.paymentId}</strong></div>
            <div style="font-size:16px;font-weight:700;color:#166534;margin-top:10px;">Refund Amount: ₹${resolvedRefund.amount}</div>
            <div style="font-size:12px;color:#4b5563;margin-top:8px;">Funds are returned directly to your original payment account (UPI/Card/NetBanking). Most banks credit this within 5–7 business days.</div>
        </div>
    `;

    const html = emailShell({
        title: "Refund Processed Successfully",
        kicker: "Refund Confirmation",
        contentHtml
    });

    return sendEmail({
        to,
        subject: `Refund Processed for Order #${String(order._id).slice(-8).toUpperCase()} - AAK Clothing`,
        html,
        transporterOverride
    });
}

/**
 * 7. Customer: Product Back-in-Stock Notification
 */
async function sendBackInStockCustomerEmail({ product, customerEmail, customerName = "Customer", baseUrl = "", transporterOverride = null }) {
    if (!customerEmail) return { success: false, error: "Missing customer email" };

    const productUrl = `${baseUrl || "https://aakclothing.com"}/product/${product._id}`;
    const imageSrc = Array.isArray(product.images) && product.images[0] ? product.images[0] : "/images/whiteimg.jpg";

    const contentHtml = `
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Hello <strong>${customerName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Good news! An item you were interested in is back in stock at AAK Clothing.</p>

        <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px;margin-bottom:24px;display:flex;gap:20px;align-items:center;">
            <div style="flex:1;">
                <h3 style="margin:0 0 6px;font-size:18px;color:#111827;">${product.name}</h3>
                <div style="font-size:16px;font-weight:700;color:#16a34a;margin-bottom:8px;">₹${Number(product.price || 0).toLocaleString()}</div>
                <div style="font-size:13px;color:#6b7280;margin-bottom:12px;">Available Stock: <strong>${product.stock} units</strong></div>
                <p style="margin:0 0 16px;font-size:13px;color:#4b5563;line-height:1.4;">${String(product.description || "").slice(0, 140)}...</p>
                <a href="${productUrl}" style="background:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:700;font-size:13px;display:inline-block;">View Product & Buy Now</a>
            </div>
        </div>
    `;

    const html = emailShell({
        title: "Back in Stock: " + product.name,
        kicker: "Stock Alert",
        contentHtml,
        footerNote: "Hurry! Popular items sell out quickly."
    });

    return sendEmail({
        to: customerEmail,
        subject: `Back in Stock: ${product.name} is available now! - AAK Clothing`,
        html,
        transporterOverride
    });
}

/**
 * 8. Customer: Important Product Information
 */
async function sendProductInfoCustomerEmail({ product, customerEmail, subject, message, customerName = "Customer", transporterOverride = null }) {
    if (!customerEmail) return { success: false, error: "Missing customer email" };

    const contentHtml = `
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Hello <strong>${customerName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Important update regarding <strong>${product.name}</strong>:</p>

        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin-bottom:24px;font-size:14px;color:#1e40af;line-height:1.6;">
            ${message}
        </div>
    `;

    const html = emailShell({
        title: subject || "Important Product Information",
        kicker: "Product Update",
        contentHtml
    });

    return sendEmail({
        to: customerEmail,
        subject: `${subject || "Product Information"}: ${product.name} - AAK Clothing`,
        html,
        transporterOverride
    });
}

// ==========================================
// ADMIN NOTIFICATIONS
// ==========================================

function getAdminEmail() {
    return process.env.ADMIN_EMAIL || process.env.EMAIL_USER || "admin@aakclothing.com";
}

/**
 * 1. Admin: New Order Received
 */
async function sendNewOrderAdminEmail({ order, transporterOverride = null }) {
    const to = getAdminEmail();
    const itemsSummary = (order.products || []).map(p => `• ${p.name || "Item"} (Qty: ${p.qty}, Price: ₹${p.price})`).join("<br>");

    const contentHtml = `
        <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:14px;margin-bottom:20px;font-size:14px;color:#92400e;">
            🔔 <strong>New Order Received:</strong> Order <code>#${order._id}</code> for ₹${order.total}.
        </div>
        <p style="margin:0 0 8px;"><strong>Customer:</strong> ${order.userName || "Customer"} (${order.userEmail || "No email"})</p>
        <p style="margin:0 0 8px;"><strong>Payment ID:</strong> <code>${order.paymentId || "N/A"}</code></p>
        <p style="margin:0 0 16px;"><strong>Items Ordered:</strong><br>${itemsSummary}</p>
    `;

    const html = emailShell({ title: "New Order Received", kicker: "Admin Order Alert", contentHtml });
    return sendEmail({ to, subject: `[ADMIN ALERT] New Order Received: #${String(order._id).slice(-8).toUpperCase()} (₹${order.total})`, html, transporterOverride });
}

/**
 * 2. Admin: New Customer Registration
 */
async function sendNewCustomerRegistrationAdminEmail({ user, transporterOverride = null }) {
    const to = getAdminEmail();
    const contentHtml = `
        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:14px;margin-bottom:20px;font-size:14px;color:#065f46;">
            👤 <strong>New Customer Registered:</strong>
        </div>
        <p style="margin:0 0 8px;"><strong>Username:</strong> ${user.username}</p>
        <p style="margin:0 0 8px;"><strong>Mobile (Verified via SMS):</strong> +91-${user.phone}</p>
        <p style="margin:0 0 8px;"><strong>Registered At:</strong> ${new Date(user.createdAt || Date.now()).toLocaleString()}</p>
    `;

    const html = emailShell({ title: "New Customer Registration", kicker: "User Account Created", contentHtml });
    return sendEmail({ to, subject: `[ADMIN ALERT] New Customer Registered: ${user.username} (+91-${user.phone})`, html, transporterOverride });
}

/**
 * 3. Admin: Product Added
 */
async function sendProductAddedAdminEmail({ product, transporterOverride = null }) {
    const to = getAdminEmail();
    const contentHtml = `
        <p style="margin:0 0 12px;font-size:14px;">A new product has been successfully added to catalog:</p>
        <ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.8;">
            <li><strong>Name:</strong> ${product.name}</li>
            <li><strong>Price:</strong> ₹${product.price}</li>
            <li><strong>Initial Stock:</strong> ${product.stock} units</li>
            <li><strong>Category ID:</strong> ${product.categoryId}</li>
        </ul>
    `;

    const html = emailShell({ title: "Product Added to Inventory", kicker: "Catalog Update", contentHtml });
    return sendEmail({ to, subject: `[INVENTORY] New Product Added: ${product.name}`, html, transporterOverride });
}

/**
 * 4. Admin: Product Updated
 */
async function sendProductUpdatedAdminEmail({ product, changes = {}, transporterOverride = null }) {
    const to = getAdminEmail();
    const changesSummary = Object.entries(changes).map(([k, v]) => `<li><strong>${k}:</strong> ${JSON.stringify(v)}</li>`).join("") || "<li>Details updated</li>";

    const contentHtml = `
        <p style="margin:0 0 12px;font-size:14px;">Product <strong>${product.name}</strong> (ID: <code>${product._id}</code>) was updated:</p>
        <ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.8;">
            ${changesSummary}
        </ul>
    `;

    const html = emailShell({ title: "Product Updated", kicker: "Catalog Update", contentHtml });
    return sendEmail({ to, subject: `[INVENTORY] Product Updated: ${product.name}`, html, transporterOverride });
}

/**
 * 5. Admin: Product Stock Low (<= 5 units)
 */
async function sendStockLowAdminEmail({ product, currentStock, transporterOverride = null }) {
    const to = getAdminEmail();
    const contentHtml = `
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px;margin-bottom:20px;">
            <div style="font-size:18px;font-weight:700;color:#b45309;">⚠️ Low Stock Warning: Only ${currentStock} left!</div>
            <p style="margin:8px 0 0;font-size:14px;color:#92400e;">
                Product <strong>${product.name}</strong> (ID: <code>${product._id}</code>) has dropped below threshold. Please reorder stock soon.
            </p>
        </div>
    `;

    const html = emailShell({ title: "Low Stock Alert", kicker: "Inventory Alert", contentHtml });
    return sendEmail({ to, subject: `[LOW STOCK WARNING] ${product.name} (Only ${currentStock} remaining)`, html, transporterOverride });
}

/**
 * 6. Admin: Product Out of Stock (0 units)
 */
async function sendOutOfStockAdminEmail({ product, transporterOverride = null }) {
    const to = getAdminEmail();
    const contentHtml = `
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-bottom:20px;">
            <div style="font-size:18px;font-weight:700;color:#991b1b;">🚨 OUT OF STOCK: ${product.name}</div>
            <p style="margin:8px 0 0;font-size:14px;color:#7f1d1d;">
                Inventory for <strong>${product.name}</strong> (ID: <code>${product._id}</code>) has reached 0 units. The product is now unavailable for customer purchase.
            </p>
        </div>
    `;

    const html = emailShell({ title: "Out of Stock Alert", kicker: "Critical Inventory Alert", contentHtml });
    return sendEmail({ to, subject: `[CRITICAL OUT OF STOCK] ${product.name} is Sold Out`, html, transporterOverride });
}

/**
 * 7. Admin: Order Cancelled
 */
async function sendOrderCancelledAdminEmail({ order, reason = "N/A", cancelledBy = "Admin", transporterOverride = null }) {
    const to = getAdminEmail();
    const contentHtml = `
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;margin-bottom:20px;font-size:14px;color:#991b1b;">
            Order <code>#${order._id}</code> has been cancelled.
        </div>
        <p style="margin:0 0 8px;"><strong>Customer:</strong> ${order.userName || "Customer"}</p>
        <p style="margin:0 0 8px;"><strong>Total Amount:</strong> ₹${order.total}</p>
        <p style="margin:0 0 8px;"><strong>Reason:</strong> ${reason}</p>
        <p style="margin:0 0 8px;"><strong>Cancelled By:</strong> ${cancelledBy}</p>
    `;

    const html = emailShell({ title: "Order Cancelled", kicker: "Order Notification", contentHtml });
    return sendEmail({ to, subject: `[ORDER CANCELLED] #${String(order._id).slice(-8).toUpperCase()} - ${reason}`, html, transporterOverride });
}

/**
 * 8. Admin: Refund Notification
 */
async function sendRefundAdminEmail({ order, refund, refundAmount, refundId, paymentId, approvedBy = "Admin", transporterOverride = null }) {
    const to = getAdminEmail();
    const resolvedRefund = {
        refundId: refund?.refundId || refundId || order.refundId || "N/A",
        paymentId: refund?.paymentId || paymentId || order.paymentId || "N/A",
        amount: refund?.amount ?? (refundAmount !== undefined ? refundAmount : order.total)
    };

    const contentHtml = `
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;margin-bottom:20px;font-size:14px;color:#166534;">
            ✓ Full Razorpay Refund Processed for Order <code>#${order._id}</code>.
        </div>
        <p style="margin:0 0 8px;"><strong>Refund ID:</strong> <code>${resolvedRefund.refundId}</code></p>
        <p style="margin:0 0 8px;"><strong>Original Payment ID:</strong> <code>${resolvedRefund.paymentId}</code></p>
        <p style="margin:0 0 8px;"><strong>Refunded Amount:</strong> ₹${resolvedRefund.amount}</p>
        <p style="margin:0 0 8px;"><strong>Approved By:</strong> ${approvedBy}</p>
    `;

    const html = emailShell({ title: "Refund Processed", kicker: "Financial Alert", contentHtml });
    return sendEmail({ to, subject: `[REFUND PROCESSED] ₹${resolvedRefund.amount} for Order #${String(order._id).slice(-8).toUpperCase()}`, html, transporterOverride });
}

/**
 * 9. Admin: Important Inventory Alert
 */
async function sendInventoryAlertAdminEmail({ title, message, items = [], transporterOverride = null }) {
    const to = getAdminEmail();
    const itemsList = items.map(i => `<li><strong>${i.name || "Item"}:</strong> Stock: ${i.stock}</li>`).join("");

    const contentHtml = `
        <p style="margin:0 0 16px;font-size:14px;line-height:1.5;">${message}</p>
        ${items.length ? `<ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.8;">${itemsList}</ul>` : ""}
    `;

    const html = emailShell({ title: title || "Inventory Alert", kicker: "Inventory Summary", contentHtml });
    return sendEmail({ to, subject: `[INVENTORY ALERT] ${title || "Inventory Status"}`, html, transporterOverride });
}

/**
 * Diagnostic helper: Sends a secure test email strictly to ADMIN_EMAIL.
 * Strictly sends only to the server-configured ADMIN_EMAIL.
 * Never sends to customers or accepts an email parameter from the browser.
 *
 * @param {Object} [options]
 * @param {string} [options.triggeredBy="Admin"]
 * @param {Object} [options.transporterOverride=null]
 * @returns {Promise<{ success: boolean, recipient: string, messageId?: string, error?: string, simulated?: boolean, timestamp: string }>}
 */
async function sendAdminTestEmail({ triggeredBy = "Admin", transporterOverride = null } = {}) {
    const to = getAdminEmail();
    const now = new Date();
    const timestamp = now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

    const contentHtml = `
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:20px;">
            <div style="font-size:16px;font-weight:700;color:#166534;">✓ Gmail SMTP Integration Verified</div>
            <p style="margin:8px 0 0;font-size:14px;color:#15803d;">
                This diagnostic test email confirms that AAK Clothing's Gmail SMTP configuration with Nodemailer is active, authenticated, and operating properly.
            </p>
        </div>

        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
            <tr style="border-bottom:1px solid #e5e7eb;">
                <td style="padding:8px 0;color:#6b7280;width:140px;"><strong>Status:</strong></td>
                <td style="padding:8px 0;color:#111827;"><span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:4px;font-weight:600;">ACTIVE</span></td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;">
                <td style="padding:8px 0;color:#6b7280;"><strong>Provider:</strong></td>
                <td style="padding:8px 0;color:#111827;">Gmail SMTP (smtp.gmail.com)</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;">
                <td style="padding:8px 0;color:#6b7280;"><strong>Target Recipient:</strong></td>
                <td style="padding:8px 0;color:#111827;"><code>${to}</code></td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;">
                <td style="padding:8px 0;color:#6b7280;"><strong>Triggered By:</strong></td>
                <td style="padding:8px 0;color:#111827;">${triggeredBy}</td>
            </tr>
            <tr>
                <td style="padding:8px 0;color:#6b7280;"><strong>Dispatched At:</strong></td>
                <td style="padding:8px 0;color:#111827;">${timestamp} IST</td>
            </tr>
        </table>

        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;font-size:12px;color:#64748b;line-height:1.5;">
            <strong>Channel Separation Reminder:</strong><br>
            • 📱 <strong>Mobile SMS (MSG91):</strong> OTP generation and verification for registration and phone changes.<br>
            • 📧 <strong>Gmail SMTP:</strong> Product alerts, order notifications, cancellations, refunds, and administrative alerts.
        </div>
    `;

    const html = emailShell({
        title: "Gmail SMTP Diagnostic Verification",
        kicker: "System Diagnostics",
        contentHtml
    });

    const result = await sendEmail({
        to,
        subject: `[SYSTEM TEST] Gmail SMTP Verified - AAK Clothing (${timestamp})`,
        html,
        transporterOverride
    });

    return {
        ...result,
        recipient: to,
        timestamp: now.toISOString()
    };
}

module.exports = {
    createTransporter,
    verifySmtpConnection,
    sendAdminTestEmail,
    sendEmail,
    emailShell,
    // Customer
    sendNewOrderCustomerEmail,
    sendOrderStatusUpdateCustomerEmail,
    sendOrderShippedCustomerEmail,
    sendOrderDeliveredCustomerEmail,
    sendOrderCancelledCustomerEmail,
    sendRefundCustomerEmail,
    sendBackInStockCustomerEmail,
    sendProductInfoCustomerEmail,
    // Admin
    sendNewOrderAdminEmail,
    sendNewCustomerRegistrationAdminEmail,
    sendProductAddedAdminEmail,
    sendProductUpdatedAdminEmail,
    sendStockLowAdminEmail,
    sendOutOfStockAdminEmail,
    sendOrderCancelledAdminEmail,
    sendRefundAdminEmail,
    sendInventoryAlertAdminEmail
};
