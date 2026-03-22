// middleware/boutiqueContext.js
// ─────────────────────────────────────────────────────────────
// Injecte req.user.boutique_id dans chaque requête.
//
// Pour un propriétaire :
//   Lit l'en-tête X-Boutique-Id ou utilise la boutique primaire.
//
// Pour un employé :
//   employeeProxy a déjà fixé req.user.boutique_id = ref_boutique_id.
//   Ce middleware NE L'ÉCRASE PAS — isolation garantie.
// ─────────────────────────────────────────────────────────────

const db = require('../db');

// Cache boutique primaire: owner_id → { id, expiresAt }
const _primaryCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function getPrimaryBoutiqueId(ownerId) {
  const cached = _primaryCache.get(ownerId);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  const { rows } = await db.query(
    'SELECT id FROM boutiques WHERE owner_id = $1 AND is_primary = true LIMIT 1',
    [ownerId]
  );

  if (!rows.length) {
    // Créer automatiquement une boutique primaire si absente
    const userRow = await db.query(
      'SELECT company_name, username, phone FROM users WHERE id = $1',
      [ownerId]
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

  // ✅ Si employeeProxy a déjà positionné boutique_id (employé assigné à une boutique),
  //    on ne l'écrase JAMAIS — c'est la garantie d'isolation par boutique.
  if (req.user.boutique_id) return next();

  try {
    const ownerId = req.user.id;

    // Le propriétaire peut demander une boutique spécifique via l'en-tête
    const requestedId = parseInt(req.headers['x-boutique-id'] || '0');

    if (requestedId) {
      const { rows } = await db.query(
        'SELECT id FROM boutiques WHERE id = $1 AND owner_id = $2',
        [requestedId, ownerId]
      );
      if (rows.length) {
        req.user.boutique_id = requestedId;
        return next();
      }
    }

    // Fallback : boutique primaire
    req.user.boutique_id = await getPrimaryBoutiqueId(ownerId);
  } catch (err) {
    console.error('boutiqueContext:', err.message);
    // fail-open
  }

  next();
}

boutiqueContext.invalidate = (ownerId) => _primaryCache.delete(ownerId);

module.exports = boutiqueContext;
