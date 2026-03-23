/**
 * boutiqueFilter.js — Helper WHERE clause d'isolation par boutique
 *
 * boutique_id = null  → boutique principale = vue CUMULATIVE
 *                        → filtre uniquement par user_id (toutes boutiques)
 * boutique_id = N     → boutique secondaire = vue ISOLÉE
 *                        → filtre par boutique_id avec fallback user_id (legacy)
 *
 * Usage :
 *   const { sql, p, bid, uid } = bf(req);
 *   db.query(`SELECT * FROM sales WHERE ${sql}`, p);
 *
 *   Avec alias :
 *   const { sql, p } = bf(req, 's');
 */
function boutiqueFilter(req, alias = '') {
  const px  = alias ? `${alias}.` : '';
  const uid = req.user.id;
  const bid = req.user.boutique_id || null;

  // Boutique principale ou pas de boutique → toutes les données de l'owner
  if (!bid) {
    return {
      sql: `${px}user_id = $1`,
      p:   [uid],
      bid: null,
      uid,
    };
  }

  // Boutique secondaire → isolation stricte
  return {
    sql: `(${px}boutique_id = $1 OR (${px}boutique_id IS NULL AND ${px}user_id = $2))`,
    p:   [bid, uid],
    bid,
    uid,
  };
}

module.exports = boutiqueFilter;
