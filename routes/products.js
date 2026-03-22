// routes/products.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

// ── Validation image base64 ──
function validateImageUrl(url) {
  if (!url) return { valid: true };
  if (typeof url !== 'string') return { valid: false, error: 'Format image invalide' };
  if (!url.startsWith('data:image/')) return { valid: false, error: 'Seules les images sont acceptées' };
  if (url.length > 200 * 1024) return { valid: false, error: 'Image trop grande (max 150 Ko)' };
  return { valid: true };
}

// ── Colonnes garanties dans la table products ──
// (celles du schéma original, toujours présentes)
const SAFE_COLS = ['name','category_id','scent','price','stock','price_achat','image_url'];

// ── Colonnes optionnelles ajoutées via migrations ──
// Détectées dynamiquement au premier appel
let _detectedCols = null;
async function getAvailableCols() {
  if (_detectedCols) return _detectedCols;
  try {
    const r = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'products'
    `);
    _detectedCols = new Set(r.rows.map(x => x.column_name));
  } catch (_) {
    _detectedCols = new Set(SAFE_COLS);
  }
  return _detectedCols;
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
    const r = await db.query(
      'SELECT * FROM products WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produit introuvable.' });
    res.json(r.rows[0]);
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
    const cols  = await getAvailableCols();
    const extra = {}; // colonnes optionnelles présentes en base
    if (cols.has('is_mixed_sale')) extra.is_mixed_sale = req.body.is_mixed_sale === true || req.body.is_mixed_sale === 'true';
    if (cols.has('lot_size'))      extra.lot_size      = parseInt(req.body.lot_size) || 1;
    if (cols.has('price_gros'))    extra.price_gros    = req.body.price_gros   != null ? parseFloat(req.body.price_gros)   : null;
    if (cols.has('price_detail'))  extra.price_detail  = req.body.price_detail != null ? parseFloat(req.body.price_detail) : null;
    if (cols.has('description'))   extra.description   = req.body.description  || null;

    const extraCols = Object.keys(extra);
    const allCols   = ['name','category_id','scent','price','stock','price_achat','user_id','image_url', ...extraCols];
    const allVals   = [
      name,
      parseInt(category_id) || null,
      scent || null,
      Number.isFinite(+price)       ? +price       : 0,
      Number.isFinite(+stock)       ? +stock       : 0,
      Number.isFinite(+price_achat) ? +price_achat : 0,
      req.user.id,
      image_url || null,
      ...extraCols.map(k => extra[k]),
    ];
    const placeholders = allVals.map((_, idx) => `$${idx + 1}`).join(',');

    const r = await db.query(
      `INSERT INTO products (${allCols.join(',')}) VALUES (${placeholders}) RETURNING *`,
      allVals
    );
    res.status(201).json(r.rows[0]);
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

    const cols = await getAvailableCols();
    const set = [], values = [];
    let i = 1;

    // Toutes les colonnes possibles avec leur conversion
    const ALL_COLS = {
      name:          v => v,
      category_id:   v => parseInt(v) || null,
      scent:         v => v || null,
      price:         v => Number.isFinite(+v) ? +v : 0,
      stock:         v => Number.isFinite(+v) ? +v : 0,
      price_achat:   v => Number.isFinite(+v) ? +v : 0,
      image_url:     v => v || null,
      description:   v => v || null,
      is_mixed_sale: v => v === true || v === 'true',
      lot_size:      v => parseInt(v) || 1,
      price_gros:    v => (v != null && v !== '') ? parseFloat(v) : null,
      price_detail:  v => (v != null && v !== '') ? parseFloat(v) : null,
    };

    for (const [col, convert] of Object.entries(ALL_COLS)) {
      // Sauter si la colonne n'existe pas en base
      if (!cols.has(col)) continue;
      // Sauter si non fourni dans le body
      if (!Object.prototype.hasOwnProperty.call(req.body, col)) continue;
      values.push(convert(req.body[col]));
      set.push(`${col} = $${i++}`);
    }

    if (set.length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });

    values.push(req.params.id);
    values.push(req.user.id);

    const r = await db.query(
      `UPDATE products SET ${set.join(', ')} WHERE id = $${i} AND user_id = $${i + 1} RETURNING *`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PATCH /products/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /products/:id
router.delete('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    const r = await db.query(
      'DELETE FROM products WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produit introuvable.' });
    res.json({ message: 'Produit supprimé' });
  } catch (err) {
    console.error('DELETE /products:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /products/:id/image
router.delete('/:id/image', verifyToken, async (req, res) => {
  try {
    const r = await db.query(
      'UPDATE products SET image_url = NULL WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Produit introuvable' });
    res.json({ message: 'Image supprimée' });
  } catch (err) {
    console.error('DELETE /products/:id/image:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
