/**
 * boutiqueFilter.js — WHERE clause helper d'isolation par boutique
 *
 * Retourne TOUJOURS p avec 2 éléments : [bid_or_null, uid]
 * Toutes les routes peuvent donc utiliser $3 pour leur propre paramètre.
 *
 * MAIS pour éviter tout problème pg avec $1=null inutilisé,
 * on construit le SQL pour n'utiliser que les params réellement passés :
 *
 * Boutique principale (bid=null) :
 *   sql = "alias.user_id = $1"   p = [uid]  (1 élément)
 *   Les routes doivent utiliser p.length+1 pour leur propre param
 *
 * Boutique secondaire (bid=N) :
 *   sql = "(alias.boutique_id=$1 OR (alias.boutique_id IS NULL AND alias.user_id=$2))"
 *   p = [bid, uid]  (2 éléments)
 *
 * Helper positionnel : bf.pos(req) → position du prochain param après p
 */
function boutiqueFilter(req, alias = '') {
  const px  = alias ? `${alias}.` : '';
  const uid = req.user.id;
  const bid = req.user.boutique_id || null;

  if (!bid) {
    return {
      sql:  `${px}user_id = $1`,
      p:    [uid],
      bid:  null,
      uid,
      next: 2,   // prochain $ disponible après p
    };
  }

  return {
    sql:  `(${px}boutique_id = $1 OR (${px}boutique_id IS NULL AND ${px}user_id = $2))`,
    p:    [bid, uid],
    bid,
    uid,
    next: 3,   // prochain $ disponible après p
  };
}

module.exports = boutiqueFilter;
