// middleware/boutiqueContext.js
// Boutique principale → req.user.boutique_id = null → toutes les données (cumul)
// Boutique secondaire → req.user.boutique_id = boutiques.id → filtre isolé

const db = require('../db');

const _primaryCache = new Map(); // ownerId → { id, expiresAt }
const CACHE_TTL = 5 * 60 * 1000;

async function getPrimaryBoutiqueId(ownerId) {
  const cached = _primaryCache.get(ownerId);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  const { rows } = await db.query(
    'SELECT id FROM boutiques WHERE owner_id = $1 AND is_primary = true LIMIT 1',
    [ownerId]
  );

  if (!rows.length) {
    const userRow = await db.query(
      'SELECT company_name, username, phone FROM users WHERE id = $1', [ownerId]
    );
    const u = userRow.rows[0] || {};
    const ins = await db.query(
      `INSERT INTO boutiques (owner_id, name, phone, emoji, is_primary)
       VALUES ($1, $2, $3, '🏪', true) RETURNING id`,
      [ownerId, u.company_name || u.username || 'Ma Boutique', u.phone || null]
    );
    const id = ins.rows[0].id;
    _primaryCache.set(ownerId, { id, expiresAt: Date.now() + CACHE_TTL });
    return id;
  }

  const id = rows[0].id;
  _primaryCache.set(ownerId, { id, expiresAt: Date.now() + CACHE_TTL });
  return id;
}

async function boutiqueContext(req, res, next) {
  if (!req.user?.id) return next();

  const path = req.originalUrl || '';
  if (path.includes('/auth') || path.includes('/admin')) return next();

  // Employé → boutique_id déjà fixé par employeeProxy, ne pas écraser
  if (req.user.boutique_id !== undefined) return next();

  try {
    const ownerId     = req.user.id;
    const requestedId = parseInt(req.headers['x-boutique-id'] || '0');

    if (requestedId) {
      const { rows } = await db.query(
        'SELECT id, is_primary FROM boutiques WHERE id = $1 AND owner_id = $2',
        [requestedId, ownerId]
      );
      if (rows.length) {
        // ✅ Boutique principale → null = vue cumulative (toutes les boutiques)
        // ✅ Boutique secondaire → filtrage isolé par boutique_id
        req.user.boutique_id = rows[0].is_primary ? null : requestedId;
        return next();
      }
    }

    // Pas de X-Boutique-Id → vue cumulative par défaut (toutes boutiques)
    req.user.boutique_id = null;

  } catch (err) {
    console.error('boutiqueContext:', err.message);
    req.user.boutique_id = null;
  }

  next();
}

boutiqueContext.invalidate = (ownerId) => _primaryCache.delete(ownerId);

module.exports = boutiqueContext;
