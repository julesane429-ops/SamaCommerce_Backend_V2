// middleware/employeeProxy.js
// ─────────────────────────────────────────────────────────────
// Si l'appelant est un employé (boutique_member accepté),
// remplace req.user.id par l'id de l'OWNER de la boutique
// ET fixe req.user.boutique_id sur la boutique précise assignée.
//
// Changements vs version précédente :
//   - Récupère ref_boutique_id (boutiques.id) depuis boutique_members
//   - Set req.user.boutique_id = ref_boutique_id pour isolation des données
//   - boutiqueContext.js n'écrase plus boutique_id si déjà positionné ici
// ─────────────────────────────────────────────────────────────

const db = require('../db');

// Cache: member_user_id → { boutiqueId, ownerId, permissions, role, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function employeeProxy(req, res, next) {
  if (!req.user?.id) return next();

  const fullPath = req.originalUrl || req.path || '';
  if (fullPath.includes('/members')) return next();
  if (fullPath.includes('/auth'))    return next();

  const userId = req.user.id;

  // Vérifier le cache
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.ownerId) {
      req.user.id          = cached.ownerId;
      req.user.boutique_id = cached.boutiqueId;   // ✅ isolation boutique précise
      req.user.isEmployee  = true;
      req.user.realId      = userId;
      req.user.permissions = cached.permissions;
      req.user.role        = cached.role;
    }
    return next();
  }

  try {
    // ✅ Récupérer ref_boutique_id (boutiques.id) ET owner via la boutique
    const { rows } = await db.query(
      `SELECT
         bm.ref_boutique_id,
         bm.permissions,
         bm.role,
         b.owner_id
       FROM boutique_members bm
       JOIN boutiques b ON bm.ref_boutique_id = b.id
       WHERE bm.member_id = $1
         AND bm.status    = 'accepted'
       LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      // Fallback legacy : chercher via boutique_id (users.id) sans ref_boutique_id
      const { rows: legacy } = await db.query(
        `SELECT bm.boutique_id, bm.permissions, bm.role
         FROM boutique_members bm
         WHERE bm.member_id = $1 AND bm.status = 'accepted'
           AND bm.ref_boutique_id IS NULL
         LIMIT 1`,
        [userId]
      );

      if (!legacy.length) {
        cache.set(userId, { ownerId: null, boutiqueId: null, permissions: null, expiresAt: Date.now() + CACHE_TTL_MS });
        return next();
      }

      // Ancien système : boutique_id = owner user_id, pas d'isolation boutique
      let permissions = legacy[0].permissions;
      if (typeof permissions === 'string') {
        try { permissions = JSON.parse(permissions); } catch { permissions = {}; }
      }

      cache.set(userId, {
        ownerId:     legacy[0].boutique_id,
        boutiqueId:  null, // pas d'isolation boutique dans ce mode legacy
        permissions: permissions || {},
        role:        legacy[0].role,
        expiresAt:   Date.now() + CACHE_TTL_MS,
      });

      req.user.id          = legacy[0].boutique_id;
      req.user.isEmployee  = true;
      req.user.realId      = userId;
      req.user.permissions = permissions || {};
      req.user.role        = legacy[0].role;
      return next();
    }

    const { ref_boutique_id, owner_id, role } = rows[0];
    let permissions = rows[0].permissions;
    if (typeof permissions === 'string') {
      try { permissions = JSON.parse(permissions); } catch { permissions = {}; }
    }
    permissions = permissions || {};

    cache.set(userId, {
      ownerId:     owner_id,
      boutiqueId:  ref_boutique_id,   // ✅ boutique précise
      permissions,
      role,
      expiresAt:   Date.now() + CACHE_TTL_MS,
    });

    // ✅ owner_id pour les requêtes user_id
    // ✅ boutique_id pour l'isolation des données par boutique
    req.user.id          = owner_id;
    req.user.boutique_id = ref_boutique_id;
    req.user.isEmployee  = true;
    req.user.realId      = userId;
    req.user.permissions = permissions;
    req.user.role        = role;

  } catch (err) {
    console.error('employeeProxy error:', err.message);
    return res.status(503).json({
      error: 'Service temporairement indisponible. Réessayez dans quelques instants.'
    });
  }

  next();
}

employeeProxy.invalidate = (memberUserId) => {
  cache.delete(memberUserId);
};

module.exports = employeeProxy;
