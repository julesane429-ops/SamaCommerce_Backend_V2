// routes/products.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verifyToken     = require('../middleware/auth');
const perm            = require('../middleware/checkPermission');
const { getProductLimit } = require('../middleware/planConfig');

// Helper : filtre ownership (boutique_id ou user_id selon le contexte)
function ownerFilter(req) {
  if (req.user.boutique_id) {
    return { col: 'boutique_id', val: req.user.boutique_id };
  }
  return { col: 'user_id', val: req.user.id };
}

// ── GET /products ── Liste les produits actifs
router.get('/', verifyToken, async (req, res) => {
  try {
    const { col, val } = ownerFilter(req);
    const { rows } = await db.query(
      `SELECT * FROM products
       WHERE ${col} = $1 AND deleted_at IS NULL
       ORDER BY id DESC`,
      [val]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /products:', err.message, err.code);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /products/:id ── Un produit spécifique
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { col, val } = ownerFilter(req);
    const { rows } = await db.query(
      `SELECT * FROM products
       WHERE id = $1 AND ${col} = $2 AND deleted_at IS NULL`,
      [req.params.id, val]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /products/:id:', err.message, err.code);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /products ── Ajouter un produit
router.post('/', verifyToken, perm('stock'), async (req, res) => {
  try {
    const { name, category_id, scent, price, stock, price_achat, image_url } = req.body;
    const userId = req.user.id;

    // Vérifier le quota produits selon le plan
    if (!req.user.isEmployee) {
      const userRow = await db.query(
        'SELECT plan, upgrade_status FROM users WHERE id = $1',
        [userId]
      );
      const user     = userRow.rows[0];
      const planName = user?.plan || 'Free';
      const isActive = user?.upgrade_status === 'validé' || planName === 'Free';
      const limit    = getProductLimit(isActive ? planName : 'Free');

      if (limit !== Infinity) {
        const { col, val } = ownerFilter(req);
        const countRow = await db.query(
          `SELECT COUNT(*)::int AS cnt FROM products WHERE ${col} = $1 AND deleted_at IS NULL`,
          [val]
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

    const { rows } = await db.query(
      `INSERT INTO products
         (name, category_id, scent, price, stock, price_achat, user_id, boutique_id, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        name,
        category_id || null,
        scent       || null,
        Number.isFinite(+price)       ? +price       : 0,
        Number.isFinite(+stock)       ? +stock       : 0,
        Number.isFinite(+price_achat) ? +price_achat : 0,
        userId,
        req.user.boutique_id || null,
        image_url || null,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    // ✅ Log complet pour déboguer sur Render
    console.error('POST /products error:', err.message, '| code:', err.code, '| detail:', err.detail);
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
});

// ── PATCH /products/:id ── Modifier un produit
router.patch('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    const fields = ['name', 'category_id', 'scent', 'price', 'stock', 'price_achat', 'image_url', 'description'];
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

    if (!set.length) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });

    // ✅ Fix : paramètres séparés pour product_id et ownership
    values.push(req.params.id); // $i
    const productParamIdx = i++;

    const { col, val } = ownerFilter(req);
    values.push(val);           // $i
    const ownerParamIdx = i++;

    const { rows } = await db.query(
      `UPDATE products
       SET ${set.join(', ')}
       WHERE id = $${productParamIdx}
         AND ${col} = $${ownerParamIdx}
         AND deleted_at IS NULL
       RETURNING *`,
      values
    );

    if (!rows.length) return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /products/:id:', err.message, err.code);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /products/:id ── Soft delete
router.delete('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    const { col, val } = ownerFilter(req);
    const { rows } = await db.query(
      `UPDATE products SET deleted_at = NOW()
       WHERE id = $1 AND ${col} = $2 AND deleted_at IS NULL
       RETURNING id`,
      [req.params.id, val]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    res.json({ message: 'Produit supprimé' });
  } catch (err) {
    console.error('DELETE /products/:id:', err.message, err.code);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /products/:id/image ── Supprimer l'image d'un produit
router.delete('/:id/image', verifyToken, async (req, res) => {
  try {
    const { col, val } = ownerFilter(req);
    const { rows } = await db.query(
      `UPDATE products SET image_url = NULL
       WHERE id = $1 AND ${col} = $2
       RETURNING id`,
      [req.params.id, val]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produit introuvable' });
    res.json({ message: 'Image supprimée' });
  } catch (err) {
    console.error('DELETE /products/:id/image:', err.message, err.code);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
