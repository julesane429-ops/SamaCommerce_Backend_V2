/**
 * boutiqueFilter.js
 *
 * TOUJOURS retourne p avec exactement 2 éléments :
 *   p[0] = bid (null si boutique principale)
 *   p[1] = uid
 *
 * Cela permet à toutes les routes d'utiliser $3 pour leur propre
 * paramètre (id, etc.) sans calculer la position dynamiquement.
 *
 * Null boutique (Pro / boutique principale) :
 *   sql = "alias.user_id = $2"   ($1 = null, ignoré)
 * Boutique secondaire (Enterprise) :
 *   sql = "(alias.boutique_id = $1 OR (alias.boutique_id IS NULL AND alias.user_id = $2))"
 */
function boutiqueFilter(req, alias = '') {
  const px  = alias ? `${alias}.` : '';
  const uid = req.user.id;
  const bid = req.user.boutique_id || null;

  if (!bid) {
    // Boutique principale : filtre par user_id uniquement
    // p[0] = null (placeholder), p[1] = uid → toujours 2 éléments
    return {
      sql: `${px}user_id = $2`,
      p:   [null, uid],
      bid: null,
      uid,
    };
  }

  // Boutique secondaire : filtre par boutique_id avec fallback user_id (legacy)
  return {
    sql: `(${px}boutique_id = $1 OR (${px}boutique_id IS NULL AND ${px}user_id = $2))`,
    p:   [bid, uid],
    bid,
    uid,
  };
}

module.exports = boutiqueFilter;
