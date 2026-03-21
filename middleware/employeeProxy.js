// middleware/employeeProxy.js
// ─────────────────────────────────────────────────────────────
// Si l'appelant est un employé (boutique_member accepté),
// remplace req.user.id par l'id du propriétaire de la boutique
// pour que toutes les requêtes SQL retournent les bonnes données.
//
// Usage dans server.js (AVANT les routes) :
//   const employeeProxy = require('./middleware/employeeProxy');
//   app.use(employeeProxy);
// ─────────────────────────────────────────────────────────────

const db = require('../db');

// Cache simple en mémoire pour éviter une requête DB à chaque appel
// TTL : 5 minutes (les permissions changent rarement)
const cache = new Map(); // key: member_user_id → { boutiqueId, permissions, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000;

async function employeeProxy(req, res, next) {
  // Pas de user décodé = pas encore passé par verifyToken, on laisse passer
  if (!req.user?.id) return next();

  const userId = req.user.id;

  // Vérifier le cache
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.boutiqueId) {
      req.user.id          = cached.boutiqueId;
      req.user.isEmployee  = true;
      req.user.realId      = userId;
      req.user.permissions = cached.permissions;
    }
    return next();
  }

  try {
    const { rows } = await db.query(
      `SELECT bm.boutique_id, bm.permissions, bm.role
       FROM boutique_members bm
       WHERE bm.member_id = $1
         AND bm.status    = 'accepted'
       LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) {
      // Pas un employé — cacher ce résultat aussi pour éviter la requête répétée
      cache.set(userId, { boutiqueId: null, permissions: null, expiresAt: Date.now() + CACHE_TTL_MS });
      return next();
    }

    const { boutique_id, permissions, role } = rows[0];

    // Stocker en cache
    cache.set(userId, {
      boutiqueId:  boutique_id,
      permissions,
      role,
      expiresAt:   Date.now() + CACHE_TTL_MS,
    });

    // Remplacer l'id pour que toutes les requêtes SQL ciblent la boutique
    req.user.id          = boutique_id;
    req.user.isEmployee  = true;
    req.user.realId      = userId;   // on garde l'id réel pour les logs
    req.user.permissions = permissions;
    req.user.role        = role;

  } catch (err) {
    console.error('employeeProxy error:', err.message);
    // En cas d'erreur DB, on laisse passer sans proxy (fail-open)
  }

  next();
}

// Invalider le cache quand les permissions changent (appelé depuis members.js)
employeeProxy.invalidate = (memberUserId) => {
  cache.delete(memberUserId);
};

module.exports = employeeProxy;
