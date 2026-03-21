// routes/products.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

// ── Valider et limiter la taille des images base64 ──
function validateImageUrl(imageUrl) {
  if (!imageUrl) return { valid: true };  // null OK (suppression)
  if (typeof imageUrl !== 'string') return { valid: false, error: 'Format image invalide' };
  // Vérifier que c'est bien une image base64
  if (!imageUrl.startsWith('data:image/')) {
    return { valid: false, error: 'Seules les images sont acceptées (data:image/...)' };
  }
  // Limiter à ~200Ko en base64 (≈150Ko image réelle)
  const MAX_B64_SIZE = 200 * 1024; // 200 Ko
  if (imageUrl.length > MAX_B64_SIZE) {
    return { valid: false, error: `Image trop grande. Maximum 150 Ko (actuel: ${Math.round(imageUrl.length/1024)} Ko)` };
  }
  return { valid: true };
}

// GET /products : Liste uniquement les produits de l'utilisateur connecté
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await db.query(
      'SELECT * FROM products WHERE user_id = $1 ORDER BY id DESC',
      [userId]
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
      'SELECT * FROM products WHERE id = $1 AND user_id = $2',
      [productId, userId]
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

    const {
      name, category_id, scent, price, stock, price_achat, image_url,
      is_mixed_sale, lot_size, price_gros, price_detail
    } = req.body;

    // Valider l'image si fournie
    if (image_url) {
      const imgCheck = validateImageUrl(image_url);
      if (!imgCheck.valid) return res.status(400).json({ error: imgCheck.error });
    }
    const userId = req.user.id;

    const result = await db.query(
      `INSERT INTO products
         (name, category_id, scent, price, stock, price_achat, user_id, image_url,
          is_mixed_sale, lot_size, price_gros, price_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        name,
        parseInt(category_id)                                 || null,
        scent                                                 || null,
        Number.isFinite(+price)       ? +price       : 0,
        Number.isFinite(+stock)       ? +stock       : 0,
        Number.isFinite(+price_achat) ? +price_achat : 0,
        userId,
        image_url                                             || null,
        is_mixed_sale === true || is_mixed_sale === 'true',
        parseInt(lot_size)                                    || 1,
        price_gros   != null && price_gros   !== '' ? parseFloat(price_gros)   : null,
        price_detail != null && price_detail !== '' ? parseFloat(price_detail) : null,
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

    // Valider l'image si fournie dans le PATCH
    if (req.body.image_url !== undefined && req.body.image_url !== null) {
      const imgCheck = validateImageUrl(req.body.image_url);
      if (!imgCheck.valid) return res.status(400).json({ error: imgCheck.error });
    }

    const fields = ['name', 'category_id', 'scent', 'price', 'stock', 'price_achat', 'image_url', 'is_mixed_sale', 'lot_size', 'price_gros', 'price_detail'];
    const set = [];
    const values = [];
    let i = 1;

    for (const f of fields) {
      if (req.body.hasOwnProperty(f)) {
        let val = req.body[f];
        // Caster chaque champ au bon type PostgreSQL
        if (['price', 'stock', 'price_achat', 'category_id'].includes(f)) {
          val = Number.isFinite(+val) ? +val : 0;
        } else if (f === 'is_mixed_sale') {
          val = val === true || val === 'true';          // boolean
        } else if (f === 'lot_size') {
          val = parseInt(val) || 1;                      // integer
        } else if (f === 'price_gros' || f === 'price_detail') {
          val = val !== null && val !== '' ? parseFloat(val) : null;  // numeric nullable
        }
        values.push(val);
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
       WHERE id = $${i++} AND user_id = $${i}
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
      'DELETE FROM products WHERE id = $1 AND user_id = $2 RETURNING *',
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
// DELETE /products/:id/image — Supprimer l'image d'un produit
router.delete('/:id/image', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE products SET image_url = NULL
       WHERE id = $1 AND user_id = $2
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
