/**
 * boutiqueFilter.js
 * Helper pour générer la clause WHERE d'isolation par boutique.
 * Gère les données migrées (boutique_id set) ET legacy (boutique_id NULL).
 *
 * Usage :
 *   const bf = require('../middleware/boutiqueFilter');
 *   const { sql, p, bid, uid } = bf(req);
 *   db.query(`SELECT * FROM sales WHERE ${sql}`, p);
 *
 *   Avec alias de table :
 *   const { sql, p } = bf(req, 's');
 *   → (s.boutique_id = $1 OR (s.boutique_id IS NULL AND s.user_id = $2))
 */
function boutiqueFilter(req, alias = '') {
  const px = alias ? `${alias}.` : '';
  return {
    sql: `(${px}boutique_id = $1 OR (${px}boutique_id IS NULL AND ${px}user_id = $2))`,
    p:   [req.user.boutique_id, req.user.id],
    bid: req.user.boutique_id,
    uid: req.user.id,
  };
}

module.exports = boutiqueFilter;
