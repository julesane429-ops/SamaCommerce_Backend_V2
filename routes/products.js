const express = require("express");
const router = express.Router();
const db = require("../db");
const verifyToken = require("../middleware/auth");


// ======================================================
// 📦 GET ALL PRODUCTS (par boutique)
// ======================================================
router.get("/", verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM products 
       WHERE shop_id = $1 
       ORDER BY id DESC`,
      [req.user.shop_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Erreur GET /products:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// 📦 GET ONE PRODUCT
// ======================================================
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM products 
       WHERE id = $1 AND shop_id = $2`,
      [req.params.id, req.user.shop_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Produit introuvable ou non autorisé"
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erreur GET /products/:id:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// ➕ CREATE PRODUCT
// ======================================================
router.post("/", verifyToken, async (req, res) => {
  try {
    const { name, category_id, scent, price, stock, price_achat } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Nom du produit requis" });
    }

    // 🔐 Vérifier que la catégorie appartient à la boutique
    if (category_id) {
      const catCheck = await db.query(
        `SELECT id FROM categories 
         WHERE id = $1 AND shop_id = $2`,
        [category_id, req.user.shop_id]
      );

      if (catCheck.rows.length === 0) {
        return res.status(403).json({
          error: "Catégorie non autorisée pour cette boutique"
        });
      }
    }

    const result = await db.query(
      `INSERT INTO products
        (name, category_id, scent, price, stock, price_achat, user_id, shop_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        name,
        category_id || null,
        scent || null,
        Number(price) || 0,
        Number(stock) || 0,
        Number(price_achat) || 0,
        req.user.id,
        req.user.shop_id
      ]
    );

    res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error("Erreur POST /products:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// ✏️ UPDATE PRODUCT
// ======================================================
router.patch("/:id", verifyToken, async (req, res) => {
  try {
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
        updates.push(`${field} = $${index}`);
        values.push(
          ["price", "stock", "price_achat", "category_id"].includes(field)
            ? Number(req.body[field]) || 0
            : req.body[field]
        );
        index++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "Aucun champ à mettre à jour" });
    }

    values.push(req.params.id);
    values.push(req.user.shop_id);

    const result = await db.query(
      `UPDATE products 
       SET ${updates.join(", ")}
       WHERE id = $${index++} AND shop_id = $${index}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Produit introuvable ou non autorisé"
      });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error("Erreur PATCH /products:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// ❌ DELETE PRODUCT
// ======================================================
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM products 
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [req.params.id, req.user.shop_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Produit introuvable ou non autorisé"
      });
    }

    res.json({ message: "Produit supprimé avec succès" });

  } catch (err) {
    console.error("Erreur DELETE /products:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
