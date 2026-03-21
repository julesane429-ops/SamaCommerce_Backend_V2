// routes/products.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

// ── GET /products ─────────────────────────────────────────────────────────
// CORRECTION #10 : filtrage des produits soft-deletés (deleted_at IS NULL).
// Avant ce correctif, les produits marqués comme supprimés continuaient
// d'apparaître dans l'inventaire et dans le formulaire de vente.
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      // ✅ Exclure les produits dont deleted_at est renseigné (suppression logique)
      'SELECT * FROM products WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur GET /products:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /products/:id ─────────────────────────────────────────────────────
// ✅ Idem : on exclut les produits soft-deletés à la récupération unitaire.
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM products WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erreur GET /products/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /products ────────────────────────────────────────────────────────
router.post('/', verifyToken, perm('stock'), async (req, res) => {
  try {
    const { name, category_id, scent, price, stock, price_achat, image_url } = req.body;
    const userId = req.user.id;

    const result = await db.query(
      `INSERT INTO products (name, category_id, scent, price, stock, price_achat, user_id, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name,
        category_id,
        scent,
        Number.isFinite(+price)       ? +price       : 0,
        Number.isFinite(+stock)       ? +stock       : 0,
        Number.isFinite(+price_achat) ? +price_achat : 0,
        userId,
        image_url || null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erreur POST /products:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /products/:id ───────────────────────────────────────────────────
// ✅ On vérifie aussi que le produit n'est pas soft-deleté avant de le modifier.
router.patch('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    const fields = ['name', 'category_id', 'scent', 'price', 'stock', 'price_achat', 'image_url'];
    const set    = [];
    const values = [];
    let i = 1;

    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body, f)) {
        if (['price', 'stock', 'price_achat', 'category_id'].includes(f)) {
          values.push(Number.isFinite(+req.body[f]) ? +req.body[f] : 0);
        } else {
          values.push(req.body[f]);
        }
        set.push(`${f} = $${i++}`);
      }
    }

    if (set.length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    values.push(req.params.id);
    values.push(req.user.id);

    const result = await db.query(
      // ✅ deleted_at IS NULL : on n'édite pas un produit déjà supprimé
      `UPDATE products SET ${set.join(', ')}
       WHERE id = $${i++} AND user_id = $${i} AND deleted_at IS NULL
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erreur PATCH /products/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /products/:id ──────────────────────────────────────────────────
// Suppression LOGIQUE (soft delete) : on renseigne deleted_at au lieu de
// supprimer la ligne. L'historique des ventes conserve ainsi la référence
// au produit (clé étrangère sales.product_id non rompue).
router.delete('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE products
       SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    }

    res.json({ message: 'Produit supprimé' });
  } catch (err) {
    console.error('Erreur DELETE /products/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /products/:id/image ────────────────────────────────────────────
router.delete('/:id/image', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE products SET image_url = NULL
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produit introuvable' });
    res.json({ message: 'Image supprimée' });
  } catch (err) {
    console.error('DELETE /products/:id/image:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
