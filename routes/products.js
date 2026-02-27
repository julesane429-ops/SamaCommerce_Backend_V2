const express = require("express");
const router = express.Router();
const db = require("../db");

const { verifyToken, requireRole } = require("../middleware/auth");
const checkSubscription = require("../middleware/subscription");

// ======================================================
// 📦 GET ALL PRODUCTS (par boutique)
// ======================================================
router.get(
  "/",
  verifyToken,
  checkSubscription,
  requireRole("owner", "employee"),
  async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT *
         FROM products
         WHERE shop_id = $1
         ORDER BY id DESC`,
        [req.user.shop_id]
      );

      res.json(rows);
    } catch (err) {
      console.error("Erreur GET /products:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// ======================================================
// 📦 GET ONE PRODUCT
// ======================================================
router.get(
  "/:id",
  verifyToken,
  checkSubscription,
  requireRole("owner", "employee"),
  async (req, res) => {
    try {
      const productId = Number(req.params.id);

      if (!productId) {
        return res.status(400).json({ error: "ID invalide" });
      }

      const { rows } = await db.query(
        `SELECT *
         FROM products
         WHERE id = $1 AND shop_id = $2`,
        [productId, req.user.shop_id]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Produit introuvable ou non autorisé"
        });
      }

      res.json(rows[0]);
    } catch (err) {
      console.error("Erreur GET /products/:id:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// ======================================================
// ➕ CREATE PRODUCT
// ======================================================
router.post(
  "/",
  verifyToken,
  checkSubscription,
  requireRole("owner", "employee"),
  async (req, res) => {
    try {
      const { name, category_id, scent, price, stock, price_achat } = req.body;

      if (!name || name.trim() === "") {
        return res.status(400).json({ error: "Nom du produit requis" });
      }

      const parsedCategory = category_id ? Number(category_id) : null;
      const parsedPrice = Number(price) || 0;
      const parsedStock = Number(stock) || 0;
      const parsedPriceAchat = Number(price_achat) || 0;

      // 🔐 Vérification catégorie
      if (parsedCategory) {
        const catCheck = await db.query(
          `SELECT id FROM categories WHERE id = $1 AND shop_id = $2`,
          [parsedCategory, req.user.shop_id]
        );

        if (catCheck.rows.length === 0) {
          return res.status(403).json({
            error: "Catégorie non autorisée"
          });
        }
      }

      const { rows } = await db.query(
        `INSERT INTO products
        (name, category_id, scent, price, stock, price_achat, shop_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *`,
        [
          name.trim(),
          parsedCategory,
          scent || null,
          parsedPrice,
          parsedStock,
          parsedPriceAchat,
          req.user.shop_id
        ]
      );

      res.status(201).json(rows[0]);

    } catch (err) {
      console.error("Erreur POST /products:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// ======================================================
// ✏️ UPDATE PRODUCT
// ======================================================
router.patch(
  "/:id",
  verifyToken,
  checkSubscription,
  requireRole("owner", "employee"),
  async (req, res) => {
    try {
      const productId = Number(req.params.id);

      if (!productId) {
        return res.status(400).json({ error: "ID invalide" });
      }

      const allowedFields = [
        "name",
        "category_id",
        "scent",
        "price",
        "stock",
        "price_achat"
      ];

      const updates = [];
      const values = [];
      let index = 1;

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {

          // 🔐 Vérification catégorie
          if (field === "category_id" && req.body[field]) {
            const catCheck = await db.query(
              `SELECT id FROM categories
               WHERE id = $1 AND shop_id = $2`,
              [Number(req.body[field]), req.user.shop_id]
            );

            if (catCheck.rows.length === 0) {
              return res.status(403).json({
                error: "Catégorie non autorisée"
              });
            }
          }

          updates.push(`${field} = $${index}`);

          if (["price", "stock", "price_achat", "category_id"].includes(field)) {
            values.push(Number(req.body[field]) || 0);
          } else {
            values.push(req.body[field]);
          }

          index++;
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: "Aucun champ à mettre à jour" });
      }

      values.push(productId, req.user.shop_id);

      const { rows } = await db.query(
        `UPDATE products
         SET ${updates.join(", ")}
         WHERE id = $${index++} AND shop_id = $${index}
         RETURNING *`,
        values
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Produit introuvable ou non autorisé"
        });
      }

      res.json(rows[0]);

    } catch (err) {
      console.error("Erreur PATCH /products:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// ======================================================
// ❌ DELETE PRODUCT
// ======================================================
router.delete(
  "/:id",
  verifyToken,
  checkSubscription,
  requireRole("owner"),
  async (req, res) => {
    try {
      const productId = Number(req.params.id);

      if (!productId) {
        return res.status(400).json({ error: "ID invalide" });
      }

      const { rows } = await db.query(
        `DELETE FROM products
         WHERE id = $1 AND shop_id = $2
         RETURNING *`,
        [productId, req.user.shop_id]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Produit introuvable ou non autorisé"
        });
      }

      res.json({ message: "Produit supprimé avec succès" });

    } catch (err) {
      console.error("Erreur DELETE /products:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

module.exports = router;
