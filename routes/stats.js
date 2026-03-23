const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');
const requirePlan = require('../middleware/checkSubscription');

// Helper réutilisable — null-safe (même logique que boutiqueFilter.js)
function boutique(req, alias = 's') {
  const px  = alias ? `${alias}.` : '';
  const uid = req.user.id;
  const bid = req.user.boutique_id || null;

  if (!bid) {
    // Boutique principale → toutes les données de l'owner
    return {
      sql:    `${px}user_id = $1`,
      params: [uid],
    };
  }
  // Boutique secondaire → filtre strict avec fallback legacy
  return {
    sql:    `(${px}boutique_id = $1 OR (${px}boutique_id IS NULL AND ${px}user_id = $2))`,
    params: [bid, uid],
  };
}

// Ventes par catégorie
router.get('/ventes-par-categorie', verifyToken, perm('rapports'), requirePlan('rapports'), async (req, res) => {
  try {
    const { sql, params } = boutique(req);
    const { rows } = await db.query(`
      SELECT c.name AS categorie,
             SUM(s.quantity)            AS total_quantite,
             SUM(s.quantity * p.price)  AS total_montant
      FROM sales s
      JOIN products   p ON s.product_id  = p.id
      JOIN categories c ON p.category_id = c.id
      WHERE ${sql}
      GROUP BY c.name
      ORDER BY total_quantite DESC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /stats/ventes-par-categorie:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Ventes par jour
router.get('/ventes-par-jour', verifyToken, perm('rapports'), async (req, res) => {
  try {
    const { sql, params } = boutique(req);
    const { rows } = await db.query(`
      SELECT DATE(s.created_at)         AS date,
             SUM(s.quantity)            AS total_quantite,
             SUM(s.quantity * p.price)  AS total_montant
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE ${sql}
      GROUP BY DATE(s.created_at)
      ORDER BY date ASC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /stats/ventes-par-jour:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Répartition paiements
router.get('/paiements', verifyToken, async (req, res) => {
  try {
    const { sql, params } = boutique(req);
    const { rows } = await db.query(`
      SELECT s.payment_method,
             COUNT(*)                   AS total_ventes,
             SUM(s.quantity * p.price)  AS total_montant
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE ${sql}
      GROUP BY s.payment_method
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /stats/paiements:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Top produits
router.get('/top-produits', verifyToken, requirePlan('rapports'), async (req, res) => {
  try {
    const { sql, params } = boutique(req);
    const { rows } = await db.query(`
      SELECT p.name                    AS produit,
             SUM(s.quantity)           AS total_quantite,
             SUM(s.quantity * p.price) AS total_montant
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE ${sql}
      GROUP BY p.name
      ORDER BY total_quantite DESC
      LIMIT 10
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /stats/top-produits:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Stock faible
router.get('/stock-faible', verifyToken, async (req, res) => {
  try {
    const seuil = parseInt(req.query.seuil) || 5;
    const { sql, params } = boutique(req, 'p');
    const { rows } = await db.query(`
      SELECT p.name AS produit, p.stock
      FROM products p
      WHERE p.stock <= $${params.length + 1}
        AND ${sql}
        AND p.deleted_at IS NULL
      ORDER BY p.stock ASC
    `, [...params, seuil]);
    res.json(rows);
  } catch (err) {
    console.error('GET /stats/stock-faible:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Stats du jour (tableau de bord)
router.get('/today', verifyToken, async (req, res) => {
  try {
    const { sql, params } = boutique(req);
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                                    AS nb_ventes,
        COALESCE(SUM(s.total), 0)::numeric                               AS ca_jour,
        COUNT(*) FILTER (WHERE s.paid = true)::int                       AS nb_encaissees,
        COALESCE(SUM(s.total) FILTER (WHERE s.paid = true), 0)::numeric  AS ca_encaisse,
        COUNT(*) FILTER (WHERE s.payment_method = 'credit' AND s.paid = false)::int AS nb_credits
      FROM sales s
      WHERE ${sql}
        AND DATE(s.created_at) = CURRENT_DATE
    `, params);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /stats/today:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
