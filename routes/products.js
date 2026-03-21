// routes/products.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

// ── Validation image base64 ──
function validateImageUrl(imageUrl) {
  if (!imageUrl) return { valid: true };
  if (typeof imageUrl !== 'string') return { valid: false, error: 'Format image invalide' };
  if (!imageUrl.startsWith('data:image/'))
    return { valid: false, error: 'Seules les images sont acceptées (data:image/...)' };
  if (imageUrl.length > 200 * 1024)
    return { valid: false, error: `Image trop grande (max 150 Ko)` };
  return { valid: true };
}

// GET /products
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM products WHERE user_id = $1 ORDER BY id DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /products:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /products/:id
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM products WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /products/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /products
router.post('/', verifyToken, perm('stock'), async (req, res) => {
  try {
    const { name, category_id, scent, price, stock, price_achat, image_url } = req.body;

    if (image_url) {
      const chk = validateImageUrl(image_url);
      if (!chk.valid) return res.status(400).json({ error: chk.error });
    }

    const result = await db.query(
      `INSERT INTO products (name, category_id, scent, price, stock, price_achat, user_id, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        name,
        parseInt(category_id) || null,
        scent || null,
        Number.isFinite(+price)       ? +price       : 0,
        Number.isFinite(+stock)       ? +stock       : 0,
        Number.isFinite(+price_achat) ? +price_achat : 0,
        req.user.id,
        image_url || null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /products:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /products/:id
router.patch('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    if (req.body.image_url != null) {
      const chk = validateImageUrl(req.body.image_url);
      if (!chk.valid) return res.status(400).json({ error: chk.error });
    }

    // Champs de base — toujours présents en base
    const BASE_FIELDS = [
      'name', 'category_id', 'scent', 'price', 'stock',
      'price_achat', 'image_url', 'description',
    ];

    // Champs vente mixte — uniquement si la migration a été exécutée
    // (on les inclut dans la tentative principale et on catch l'erreur colonne)
    const MIXED_FIELDS = ['is_mixed_sale', 'lot_size', 'price_gros', 'price_detail'];

    function buildQuery(fieldList) {
      const set = [], values = [];
      let i = 1;
      for (const f of fieldList) {
        if (!Object.prototype.hasOwnProperty.call(req.body, f)) continue;
        let val = req.body[f];
        if (['price', 'stock', 'price_achat', 'category_id'].includes(f)) {
          val = Number.isFinite(+val) ? +val : 0;
        } else if (f === 'is_mixed_sale') {
          val = val === true || val === 'true';
        } else if (f === 'lot_size') {
          val = parseInt(val) || 1;
        } else if (f === 'price_gros' || f === 'price_detail') {
          val = (val !== null && val !== '' && val !== undefined) ? parseFloat(val) : null;
        }
        values.push(val);
        set.push(`${f} = $${i++}`);
      }
      return { set, values, i };
    }

    // Essayer d'abord avec tous les champs (base + mixte)
    const hasMixed = MIXED_FIELDS.some(f =>
      Object.prototype.hasOwnProperty.call(req.body, f)
    );
    const fieldsToUse = hasMixed ? [...BASE_FIELDS, ...MIXED_FIELDS] : BASE_FIELDS;
    const { set, values, i } = buildQuery(fieldsToUse);

    if (set.length === 0)
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });

    values.push(req.params.id);
    values.push(req.user.id);

    try {
      const result = await db.query(
        `UPDATE products SET ${set.join(', ')}
         WHERE id = $${i} AND user_id = $${i + 1}
         RETURNING *`,
        values
      );
      if (!result.rows.length)
        return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
      return res.json(result.rows[0]);

    } catch (dbErr) {
      // Si les colonnes vente mixte n'existent pas encore (migration non exécutée)
      // → réessayer sans les champs mixtes
      if (dbErr.message && dbErr.message.includes('column') &&
          dbErr.message.includes('does not exist')) {

        const { set: s2, values: v2, i: i2 } = buildQuery(BASE_FIELDS);
        if (s2.length === 0)
          return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
        v2.push(req.params.id);
        v2.push(req.user.id);

        const r2 = await db.query(
          `UPDATE products SET ${s2.join(', ')}
           WHERE id = $${i2} AND user_id = $${i2 + 1}
           RETURNING *`,
          v2
        );
        if (!r2.rows.length)
          return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
        return res.json(r2.rows[0]);
      }
      throw dbErr; // autre erreur → remonter
    }

  } catch (err) {
    console.error('PATCH /products/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /products/:id
router.delete('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM products WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    res.json({ message: 'Produit supprimé' });
  } catch (err) {
    console.error('DELETE /products:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /products/:id/image
router.delete('/:id/image', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE products SET image_url = NULL WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produit introuvable' });
    res.json({ message: 'Image supprimée' });
  } catch (err) {
    console.error('DELETE /products/:id/image:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
