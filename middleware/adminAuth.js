function requireAdmin(req, res, next) {
    if (req.session && req.session.admin) {
        return next();
    }

    return res.redirect("/admin/login");
}

module.exports = { requireAdmin };
