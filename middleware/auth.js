const jwt = require("jsonwebtoken");
const db = require("../db");

/**
 * 🔐 Vérifie JWT + charge user depuis DB
 */
async function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader) {
    return res.status(401).json({ message: "Authorization header manquant" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Token manquant" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 🔎 Charger user réel depuis DB
    const { rows } = await db.query(
      `SELECT id, email, role, shop_id, is_active
       FROM users
       WHERE id = $1`,
      [decoded.id]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "Utilisateur introuvable" });
    }

    const user = rows[0];

    if (!user.is_active) {
      return res.status(403).json({ message: "Compte désactivé" });
    }

    req.user = user;

    next();

  } catch (err) {
    return res.status(403).json({ message: "Token invalide ou expiré" });
  }
}

/**
 * 🎯 Middleware pour restreindre par rôle
 * Exemple: requireRole('owner', 'super_admin')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Accès non autorisé" });
    }
    next();
  };
}

module.exports = {
  verifyToken,
  requireRole
};
