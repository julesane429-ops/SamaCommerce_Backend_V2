const express = require("express");
const router = express.Router();
const db = require("../db");

const { verifyToken, requireRole } = require("../middleware/auth");
const checkSubscription = require("../middleware/subscription");


/* ======================================================
   📂 GET ALL CATEGORIES
====================================================== */

router.get(
  "/",
  verifyToken,
  checkSubscription,
  requireRole("owner", "employee"),
  async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT id, name, emoji, couleur
         FROM categories
         WHERE shop_id = $1
         ORDER BY id ASC`,
        [req.user.shop_id]
      );

      res.json(rows);

    } catch (err) {
      console.error("❌ GET /categories:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);


/* ======================================================
   ➕ CREATE CATEGORY
====================================================== */

router.post(
  "/",
  verifyToken,
  checkSubscription,
  requireRole("owner", "employee"),
  async (req, res) => {
    try {
      let { name, emoji, couleur } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({
          error: "Le nom de la catégorie est requis"
        });
      }

      name = name.trim();

      // 🔥 Empêcher doublon
      const exists = await db.query(
        `SELECT id FROM categories 
         WHERE name = $1 AND shop_id = $2`,
        [name, req.user.shop_id]
      );

      if (exists.rowCount > 0) {
        return res.status(400).json({
          error: "Cette catégorie existe déjà"
        });
      }

      const { rows } = await db.query(
        `INSERT INTO categories 
          (shop_id, name, emoji, couleur)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, emoji, couleur`,
        [
          req.user.shop_id,
          name,
          emoji || "🏷️",
          couleur || null
        ]
      );

      res.status(201).json(rows[0]);

    } catch (err) {
      console.error("❌ POST /categories:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);


/* ======================================================
   ✏️ UPDATE CATEGORY
====================================================== */

router.patch(
  "/:id",
  verifyToken,
  checkSubscription,
  requireRole("owner", "employee"),
  async (req, res) => {
    try {
      const categoryId = parseInt(req.params.id, 10);

      if (isNaN(categoryId)) {
        return res.status(400).json({ error: "ID invalide" });
      }

      const { name, emoji, couleur } = req.body;

      const updates = [];
      const values = [];
      let index = 1;

      // 🔥 NAME sécurisé
      if (name !== undefined) {
        if (!name || !name.trim()) {
          return res.status(400).json({
            error: "Nom invalide"
          });
        }
        updates.push(`name = $${index++}`);
        values.push(name.trim());
      }

      if (emoji !== undefined) {
        updates.push(`emoji = $${index++}`);
        values.push(emoji);
      }

      if (couleur !== undefined) {
        updates.push(`couleur = $${index++}`);
        values.push(couleur);
      }

      if (updates.length === 0) {
        return res.status(400).json({
          error: "Aucun champ à mettre à jour"
        });
      }

      values.push(categoryId);
      values.push(req.user.shop_id);

      const { rows } = await db.query(
        `UPDATE categories
         SET ${updates.join(", ")}
         WHERE id = $${index++} AND shop_id = $${index}
         RETURNING id, name, emoji, couleur`,
        values
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Catégorie introuvable ou non autorisée"
        });
      }

      res.json(rows[0]);

    } catch (err) {
      console.error("❌ PATCH /categories:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);


/* ======================================================
   ❌ DELETE CATEGORY
====================================================== */

router.delete(
  "/:id",
  verifyToken,
  checkSubscription,
  requireRole("owner"),
  async (req, res) => {
    try {
      const categoryId = parseInt(req.params.id, 10);

      if (isNaN(categoryId)) {
        return res.status(400).json({ error: "ID invalide" });
      }

      // 🔥 Vérifier produits liés DIRECTEMENT
      const prodCheck = await db.query(
        `SELECT 1 
         FROM products 
         WHERE category_id = $1 AND shop_id = $2
         LIMIT 1`,
        [categoryId, req.user.shop_id]
      );

      if (prodCheck.rowCount > 0) {
        return res.status(400).json({
          error: "Impossible de supprimer : catégorie contient des produits"
        });
      }

      const { rowCount } = await db.query(
        `DELETE FROM categories 
         WHERE id = $1 AND shop_id = $2`,
        [categoryId, req.user.shop_id]
      );

      if (rowCount === 0) {
        return res.status(404).json({
          error: "Catégorie introuvable ou non autorisée"
        });
      }

      res.json({
        message: "Catégorie supprimée avec succès"
      });

    } catch (err) {
      console.error("❌ DELETE /categories:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);


module.exports = router;
