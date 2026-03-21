// middleware/checkPermission.js
// ─────────────────────────────────────────────────────────────
// Vérifie que l'employé a la permission requise pour accéder
// à une route. Les propriétaires de boutique passent toujours.
//
// Usage :
//   const perm = require('./middleware/checkPermission');
//   router.get('/', verifyToken, perm('rapports'), async (req, res) => { ... });
// ─────────────────────────────────────────────────────────────

function checkPermission(permissionKey) {
  return function (req, res, next) {
    // Pas un employé → propriétaire → accès total
    if (!req.user?.isEmployee) return next();

    const perms = req.user.permissions || {};

    if (!perms[permissionKey]) {
      return res.status(403).json({
        error:      'Accès refusé',
        permission: permissionKey,
        message:    `Vous n'avez pas la permission "${permissionKey}". Contactez le propriétaire de la boutique.`,
      });
    }

    next();
  };
}

module.exports = checkPermission;
