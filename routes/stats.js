const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');
const perm           = require('../middleware/checkPermission');
const requirePremium = require('../middleware/checkSubscription');

// Ventes par catégorie
router.get('/ventes-par-categorie', verifyToken, perm('rapports'), requirePremium, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.name AS categorie,
             SUM(s.quantity) AS total_quantite,
             SUM(s.quantity * p.price) AS total_montant
      FROM sales s
      JOIN products p ON s.product_id = p.id
      JOIN categories c ON p.category_id = c.id
      WHERE s.user_id = $1
      GROUP BY c.name
      ORDER BY total_quantite DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Ventes par jour
router.get('/ventes-par-jour', verifyToken, perm('rapports'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT DATE(s.created_at) AS date,
             SUM(s.quantity) AS total_quantite,
             SUM(s.quantity * p.price) AS total_montant
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE s.user_id = $1
      GROUP BY DATE(s.created_at)
      ORDER BY date ASC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Répartition paiements
router.get('/paiements', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT s.payment_method,
             COUNT(*) AS total_ventes,
             SUM(s.quantity * p.price) AS total_montant
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE s.user_id = $1
      GROUP BY s.payment_method
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Top produits
router.get('/top-produits', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT p.name AS produit,
             SUM(s.quantity) AS total_quantite,
             SUM(s.quantity * p.price) AS total_montant
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE s.user_id = $1
      GROUP BY p.name
      ORDER BY total_quantite DESC
      LIMIT 10
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Stock faible
router.get('/stock-faible', verifyToken, async (req, res) => {
  try {
    const seuil = parseInt(req.query.seuil) || 5;
    const { rows } = await db.query(`
      SELECT p.name AS produit,
             p.stock
      FROM products p
      WHERE p.stock <= $1
        AND p.user_id = $2
      ORDER BY p.stock ASC
    `, [seuil, req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// ═══════════════════════════════════════════════════════════
// PATCH routes/stats.js
// Ajouter cette route avant module.exports = router;
// ═══════════════════════════════════════════════════════════

// ── GET /stats/today ── Ventes + CA du jour en temps réel
router.get('/today', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                    AS nb_ventes,
        COALESCE(SUM(s.total), 0)::numeric               AS ca_jour,
        COUNT(*) FILTER (WHERE s.paid = true)::int       AS nb_encaissees,
        COALESCE(SUM(s.total) FILTER (WHERE s.paid = true), 0)::numeric AS ca_encaisse,
        COUNT(*) FILTER (WHERE s.payment_method = 'credit' AND s.paid = false)::int AS nb_credits
      FROM sales s
      WHERE s.user_id = $1
        AND DATE(s.created_at) = CURRENT_DATE
    `, [req.user.id]);

    res.json(rows[0]);
  } catch (err) {
    console.error('GET /stats/today:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
module.exports = router;
