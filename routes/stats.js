const express = require("express");
const router = express.Router();
const db = require("../db");
const verifyToken = require("../middleware/auth");


// ======================================================
// 📊 VENTES PAR CATÉGORIE
// ======================================================
router.get("/ventes-par-categorie", verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.name AS categorie,
              SUM(s.quantity) AS total_quantite,
              SUM(s.total) AS total_montant
       FROM sales s
       JOIN products p ON s.product_id = p.id
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE s.shop_id = $1
       GROUP BY c.name
       ORDER BY total_quantite DESC`,
      [req.user.shop_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("Erreur ventes-par-categorie:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// 📅 VENTES PAR JOUR
// ======================================================
router.get("/ventes-par-jour", verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT DATE(s.created_at) AS date,
              SUM(s.quantity) AS total_quantite,
              SUM(s.total) AS total_montant
       FROM sales s
       WHERE s.shop_id = $1
       GROUP BY DATE(s.created_at)
       ORDER BY date ASC`,
      [req.user.shop_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("Erreur ventes-par-jour:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// 💳 RÉPARTITION DES PAIEMENTS
// ======================================================
router.get("/paiements", verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT payment_method,
              COUNT(*) AS total_ventes,
              SUM(total) AS total_montant
       FROM sales
       WHERE shop_id = $1
       GROUP BY payment_method`,
      [req.user.shop_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("Erreur paiements:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// 🏆 TOP PRODUITS
// ======================================================
router.get("/top-produits", verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.name AS produit,
              SUM(s.quantity) AS total_quantite,
              SUM(s.total) AS total_montant
       FROM sales s
       JOIN products p ON s.product_id = p.id
       WHERE s.shop_id = $1
       GROUP BY p.name
       ORDER BY total_quantite DESC
       LIMIT 10`,
      [req.user.shop_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("Erreur top-produits:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// ⚠️ STOCK FAIBLE
// ======================================================
router.get("/stock-faible", verifyToken, async (req, res) => {
  try {
    const seuil = parseInt(req.query.seuil) || 5;

    const { rows } = await db.query(
      `SELECT name AS produit, stock
       FROM products
       WHERE stock <= $1
       AND shop_id = $2
       ORDER BY stock ASC`,
      [seuil, req.user.shop_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("Erreur stock-faible:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
