// routes/products.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');
const perm           = require('../middleware/checkPermission');
const { getProductLimit } = require('../middleware/planConfig');

// GET /products : Liste uniquement les produits de l'utilisateur connecté
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await db.query(
      `SELECT * FROM products WHERE ${req.user.boutique_id ? 'boutique_id' : 'user_id'} = $1 ORDER BY id DESC`,
      [req.user.boutique_id || userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Erreur GET /products:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ GET /products/:id : Récupère un produit spécifique (sécurisé par user_id)
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const productId = req.params.id;

    const result = await db.query(
      `SELECT * FROM products WHERE id = $1 AND (boutique_id = $2 OR (boutique_id IS NULL AND user_id = $2))`,
      [productId, req.user.boutique_id || userId]
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


// POST /products : Ajoute un produit lié à l'utilisateur connecté
router.post('/', verifyToken, perm('stock'), async (req, res) => {
  try {
    const { name, category_id, scent, price, stock, price_achat, image_url } = req.body;
    const userId = req.user.id;

    // Vérifier le quota produits selon le plan (côté serveur — non-bypassable)
    if (!req.user.isEmployee) {
      const userRow = await db.query(
        'SELECT plan, upgrade_status FROM users WHERE id = $1',
        [userId]
      );
      const user      = userRow.rows[0];
      const planName  = user?.plan || 'Free';
      const isActive  = user?.upgrade_status === 'validé' || planName === 'Free';
      const limit     = getProductLimit(isActive ? planName : 'Free');

      if (limit !== Infinity) {
        const countRow = await db.query(
          `SELECT COUNT(*)::int AS cnt FROM products WHERE ${req.user.boutique_id ? 'boutique_id' : 'user_id'} = $1`,
          [req.user.boutique_id || userId]
        );
        if (countRow.rows[0].cnt >= limit) {
          return res.status(403).json({
            error:            'Limite atteinte',
            code:             'PRODUCT_LIMIT_REACHED',
            limit,
            plan:             planName,
            message:          `Le plan ${planName} est limité à ${limit} produit${limit > 1 ? 's' : ''}. Passez au plan supérieur pour continuer.`,
            upgrade_required: true,
          });
        }
      }
    }

    const result = await db.query(
      `INSERT INTO products (name, category_id, scent, price, stock, price_achat, user_id, boutique_id, image_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        name,
        category_id,
        scent,
        Number.isFinite(+price) ? +price : 0,
        Number.isFinite(+stock) ? +stock : 0,
        Number.isFinite(+price_achat) ? +price_achat : 0,
        userId, req.user.boutique_id || null, image_url || null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erreur POST /products:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /products/:id : Met à jour uniquement les produits appartenant à l'utilisateur
router.patch('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {

    const fields = ['name', 'category_id', 'scent', 'price', 'stock', 'price_achat', 'image_url'];
    const set = [];
    const values = [];
    let i = 1;

    for (const f of fields) {
      if (req.body.hasOwnProperty(f)) {
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

    // Ajout du filtre par user_id pour sécuriser la modification
    values.push(req.params.id);
    values.push(req.user.id);

    const result = await db.query(
      `UPDATE products SET ${set.join(', ')}
       WHERE id = $${i++} AND (boutique_id = $${i} OR (boutique_id IS NULL AND user_id = $${i}))
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

// DELETE /products/:id : Supprime uniquement les produits appartenant à l'utilisateur
router.delete('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM products WHERE id = $1 AND (boutique_id = $2 OR (boutique_id IS NULL AND user_id = $2)) RETURNING *`,
      [req.params.id, req.user.boutique_id || req.user.id]
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
// DELETE /products/:id/image — Supprimer l'image d'un produit
router.delete('/:id/image', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE products SET image_url = NULL
       WHERE id = $1 AND (boutique_id = $2 OR (boutique_id IS NULL AND user_id = $2))
       RETURNING id`,
      [req.params.id, req.user.boutique_id || req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produit introuvable' });
    res.json({ message: 'Image supprimée' });
  } catch (err) {
    console.error('DELETE /products/:id/image:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
module.exports = router;
