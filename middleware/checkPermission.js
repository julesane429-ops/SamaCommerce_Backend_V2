// middleware/checkPermission.js
function checkPermission(permissionKey) {
  return function (req, res, next) {
    // Propriétaire → accès total
    if (!req.user?.isEmployee) return next();

    // Normaliser : permissions peut être une string JSON selon le driver pg
    let perms = req.user.permissions || {};
    if (typeof perms === 'string') {
      try { perms = JSON.parse(perms); } catch { perms = {}; }
    }

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
