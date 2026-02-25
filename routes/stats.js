const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');

// Ventes par catégorie
router.get('/ventes-par-categorie', verifyToken, async (req, res) => {
  console.log("👤 Utilisateur authentifié:", req.user);
  try {
    const { rows } = await db.query(`
      SELECT c.name AS categorie,
             SUM(s.quantity) AS total_quantite,
             SUM(s.quantity * p.price) AS total_montant
      FROM sales s
      JOIN products p ON s.product_id = p.id
      JOIN categories c ON p.category_id = c.id
      WHERE s.shop_id = $1
      GROUP BY c.name
      ORDER BY total_quantite DESC
    `, [req.user.shop_id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Ventes par jour
router.get('/ventes-par-jour', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT DATE(s.created_at) AS date,
             SUM(s.quantity) AS total_quantite,
             SUM(s.quantity * p.price) AS total_montant
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE s.shop_id = $1
      GROUP BY DATE(s.created_at)
      ORDER BY date ASC
    `, [req.user.shop_id]);
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
      WHERE s.shop_id = $1
      GROUP BY s.payment_method
    `, [req.user.shop_id]);
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
      WHERE s.shop_id = $1
      GROUP BY p.name
      ORDER BY total_quantite DESC
      LIMIT 10
    `, [req.user.shop_id]);
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
        AND p.shop_id = $2
      ORDER BY p.stock ASC
    `, [seuil, req.user.shop_id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
