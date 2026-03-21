// routes/products.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

// ── GET /products ─────────────────────────────────────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, category_id, scent, description, price, price_achat,
              stock, stock_reserved, image_url,
              price_gros, quantite_gros,
              deleted_at, updated_at, user_id
       FROM products
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY id DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur GET /products:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /products/:id ─────────────────────────────────────────────────────
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, category_id, scent, description, price, price_achat,
              stock, stock_reserved, image_url,
              price_gros, quantite_gros,
              deleted_at, updated_at, user_id
       FROM products
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
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
    const {
      name, category_id, scent, description,
      price, stock, price_achat, image_url,
      price_gros, quantite_gros
    } = req.body;
    const userId = req.user.id;

    // Valider la cohérence gros : les deux ensemble ou aucun
    const hasGros = price_gros != null || quantite_gros != null;
    if (hasGros && (price_gros == null || quantite_gros == null)) {
      return res.status(400).json({
        error: 'price_gros et quantite_gros doivent être renseignés ensemble.'
      });
    }

    const result = await db.query(
      `INSERT INTO products
        (name, category_id, scent, description, price, stock, price_achat,
         user_id, image_url, price_gros, quantite_gros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        name,
        category_id   || null,
        scent         || null,
        description   || null,
        Number.isFinite(+price)       ? +price       : 0,
        Number.isFinite(+stock)       ? +stock       : 0,
        Number.isFinite(+price_achat) ? +price_achat : 0,
        userId,
        image_url     || null,
        price_gros    != null ? +price_gros    : null,
        quantite_gros != null ? +quantite_gros : null
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erreur POST /products:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /products/:id ───────────────────────────────────────────────────
router.patch('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    const updatableFields = [
      'name', 'category_id', 'scent', 'description',
      'price', 'stock', 'price_achat', 'image_url',
      'price_gros', 'quantite_gros'
    ];
    const numericFields = ['price', 'stock', 'price_achat', 'category_id', 'price_gros', 'quantite_gros'];

    const set    = [];
    const values = [];
    let i = 1;

    for (const f of updatableFields) {
      if (!Object.prototype.hasOwnProperty.call(req.body, f)) continue;
      const val = req.body[f];
      // Permettre NULL explicite pour price_gros et quantite_gros
      if (val === null && ['price_gros', 'quantite_gros'].includes(f)) {
        values.push(null);
      } else if (numericFields.includes(f)) {
        values.push(Number.isFinite(+val) ? +val : 0);
      } else {
        values.push(val);
      }
      set.push(`${f} = $${i++}`);
    }

    if (set.length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Vérifier cohérence gros après merge avec valeurs existantes
    // On récupère le produit actuel pour tester la cohérence finale
    const current = await db.query(
      'SELECT price_gros, quantite_gros FROM products WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [req.params.id, req.user.id]
    );
    if (!current.rows.length) {
      return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    }
    const cur = current.rows[0];
    const finalPriceGros    = req.body.hasOwnProperty('price_gros')    ? req.body.price_gros    : cur.price_gros;
    const finalQuantiteGros = req.body.hasOwnProperty('quantite_gros') ? req.body.quantite_gros : cur.quantite_gros;
    const hasGros = finalPriceGros != null || finalQuantiteGros != null;
    if (hasGros && (finalPriceGros == null || finalQuantiteGros == null)) {
      return res.status(400).json({
        error: 'price_gros et quantite_gros doivent être renseignés ensemble ou tous les deux à null.'
      });
    }

    values.push(req.params.id);
    values.push(req.user.id);

    const result = await db.query(
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

// ── DELETE /products/:id — Soft delete ───────────────────────────────────
router.delete('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE products SET deleted_at = NOW()
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
