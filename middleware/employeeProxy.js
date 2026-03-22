// middleware/employeeProxy.js
// ─────────────────────────────────────────────────────────────
// Si l'appelant est un employé (boutique_member accepté) :
//   - req.user.id          = owner_user_id  (pour les requêtes WHERE user_id)
//   - req.user.boutique_id = ref_boutique_id (pour les requêtes WHERE boutique_id)
//   - req.user.isEmployee  = true
//   - req.user.realId      = employee user_id réel
//   - req.user.permissions = ses permissions
//
// ✅ Correction multi-boutique : on injecte aussi ref_boutique_id
//    pour que l'employé ne voie que les données de SA boutique,
//    pas toutes les boutiques de l'owner.
// ─────────────────────────────────────────────────────────────

const db = require('../db');

const cache      = new Map();
const CACHE_TTL  = 5 * 60 * 1000;

async function employeeProxy(req, res, next) {
  if (!req.user?.id) return next();

  const fullPath = req.originalUrl || req.path || '';
  if (fullPath.includes('/members')) return next();
  if (fullPath.includes('/auth'))    return next();

  const userId = req.user.id;

  // ── Cache ──
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.ownerUserId) {
      req.user.id          = cached.ownerUserId;
      req.user.boutique_id = cached.refBoutiqueId;
      req.user.isEmployee  = true;
      req.user.realId      = userId;
      req.user.permissions = cached.permissions;
    }
    return next();
  }

  try {
    const { rows } = await db.query(`
      SELECT bm.boutique_id  AS owner_user_id_legacy,
             bm.owner_user_id,
             bm.ref_boutique_id,
             bm.permissions,
             bm.role
      FROM boutique_members bm
      WHERE bm.member_id = $1
        AND bm.status    = 'accepted'
      LIMIT 1
    `, [userId]);

    if (rows.length === 0) {
      cache.set(userId, {
        ownerUserId:  null,
        refBoutiqueId: null,
        permissions:  null,
        expiresAt:    Date.now() + CACHE_TTL
      });
      return next();
    }

    const row = rows[0];

    // ✅ owner_user_id est la source de vérité depuis la migration.
    //    Fallback sur boutique_id (ancienne colonne = user_id) pour rétrocompat.
    const ownerUserId   = row.owner_user_id || row.owner_user_id_legacy;
    const refBoutiqueId = row.ref_boutique_id || null;

    let permissions = row.permissions;
    if (typeof permissions === 'string') {
      try { permissions = JSON.parse(permissions); } catch { permissions = {}; }
    }
    permissions = permissions || {};

    cache.set(userId, {
      ownerUserId,
      refBoutiqueId,
      permissions,
      role:      row.role,
      expiresAt: Date.now() + CACHE_TTL,
    });

    // ── Injection dans req.user ──
    req.user.id          = ownerUserId;     // owner → toutes les requêtes user_id trouvent les données
    req.user.boutique_id = refBoutiqueId;   // boutique spécifique → filtre WHERE boutique_id
    req.user.isEmployee  = true;
    req.user.realId      = userId;
    req.user.permissions = permissions;
    req.user.role        = row.role;

  } catch (err) {
    console.error('employeeProxy error:', err.message);
    return res.status(503).json({
      error: 'Service temporairement indisponible. Réessayez dans quelques instants.'
    });
  }

  next();
}

employeeProxy.invalidate = (memberUserId) => cache.delete(memberUserId);

module.exports = employeeProxy;
