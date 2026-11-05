function requireAdmin(req, res, next) {
    if (req.session && req.session.admin) {
        return next();
    }

    if (req.xhr || req.headers.accept?.includes("application/json") || req.path === "/test-email") {
        return res.status(401).json({ ok: false, message: "Unauthorized: Admin session required." });
    }

    return res.redirect("/admin/login");
}

module.exports = { requireAdmin };
