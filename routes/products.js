// routes/products.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verifyToken         = require('../middleware/auth');
const perm                = require('../middleware/checkPermission');
const { getProductLimit } = require('../middleware/planConfig');

// ── Helper : clause WHERE adaptée boutique_id / user_id ───────────
// Si req.user.boutique_id est injecté (multi-boutique ou employé),
// on filtre par boutique précise. Sinon on filtre par user_id (legacy).
function scopeClause(req) {
  if (req.user.boutique_id) {
    return {
      clause: '(boutique_id = $1 OR (boutique_id IS NULL AND user_id = $2))',
      params: [req.user.boutique_id, req.user.id],
    };
  }
  return {
    clause: 'user_id = $1',
    params: [req.user.id],
  };
}

// Décale les indices $N d'une clause de +offset pour les combiner
function shiftClause(clause, offset) {
  return clause.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + offset}`);
}

// ── GET /products ─────────────────────────────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const { clause, params } = scopeClause(req);
    const result = await db.query(
      `SELECT * FROM products WHERE ${clause} AND deleted_at IS NULL ORDER BY id DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur GET /products:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /products/:id ─────────────────────────────────────────────
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { clause, params } = scopeClause(req);
    const result = await db.query(
      `SELECT * FROM products WHERE id = $${params.length + 1} AND ${clause} AND deleted_at IS NULL`,
      [...params, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erreur GET /products/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /products ────────────────────────────────────────────────
router.post('/', verifyToken, perm('stock'), async (req, res) => {
  try {
    const {
      name, category_id, scent, description,
      price, stock, price_achat, image_url,
      price_gros, quantite_gros
    } = req.body;
    const userId     = req.user.id;
    const boutiqueId = req.user.boutique_id || null;

    // ── Vérifier le quota produits selon le plan ──
    if (!req.user.isEmployee) {
      const userRow  = await db.query('SELECT plan, upgrade_status FROM users WHERE id = $1', [userId]);
      const planName = userRow.rows[0]?.plan || 'Free';
      const isActive = userRow.rows[0]?.upgrade_status === 'validé' || planName === 'Free';
      const limit    = getProductLimit(isActive ? planName : 'Free');

      if (limit !== Infinity) {
        const { clause, params } = scopeClause(req);
        const countRow = await db.query(
          `SELECT COUNT(*)::int AS cnt FROM products WHERE ${clause} AND deleted_at IS NULL`,
          params
        );
        if (countRow.rows[0].cnt >= limit) {
          return res.status(403).json({
            error:            'Limite atteinte',
            code:             'PRODUCT_LIMIT_REACHED',
            limit,
            plan:             planName,
            message:          `Le plan ${planName} est limité à ${limit} produit${limit > 1 ? 's' : ''}. Passez au plan supérieur.`,
            upgrade_required: true,
          });
        }
      }
    }

    // ── Validation cohérence gros ──
    const hasGros = price_gros != null || quantite_gros != null;
    if (hasGros && (price_gros == null || quantite_gros == null)) {
      return res.status(400).json({ error: 'price_gros et quantite_gros doivent être renseignés ensemble.' });
    }

    const result = await db.query(
      `INSERT INTO products
        (name, category_id, scent, description, price, stock, price_achat,
         user_id, boutique_id, image_url, price_gros, quantite_gros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
        boutiqueId,
        image_url     || null,
        price_gros    != null ? +price_gros    : null,
        quantite_gros != null ? +quantite_gros : null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erreur POST /products:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /products/:id ───────────────────────────────────────────
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
      if (val === null && ['price_gros', 'quantite_gros'].includes(f)) {
        values.push(null);
      } else if (numericFields.includes(f)) {
        values.push(Number.isFinite(+val) ? +val : 0);
      } else {
        values.push(val);
      }
      set.push(`${f} = $${i++}`);
    }

    if (!set.length) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });

    // id du produit
    values.push(req.params.id);
    const idIdx = i++;

    // scope boutique/user
    const { clause, params } = scopeClause(req);
    const scopedClause = shiftClause(clause, i - 1);
    values.push(...params);

    const result = await db.query(
      `UPDATE products SET ${set.join(', ')}
       WHERE id = $${idIdx} AND ${scopedClause} AND deleted_at IS NULL
       RETURNING *`,
      values
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erreur PATCH /products/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /products/:id ── Soft delete ───────────────────────────
router.delete('/:id', verifyToken, perm('stock'), async (req, res) => {
  try {
    const { clause, params } = scopeClause(req);
    const scopedClause = shiftClause(clause, 1);

    const result = await db.query(
      `UPDATE products SET deleted_at = NOW()
       WHERE id = $1 AND ${scopedClause} AND deleted_at IS NULL
       RETURNING id`,
      [req.params.id, ...params]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    res.json({ message: 'Produit supprimé' });
  } catch (err) {
    console.error('Erreur DELETE /products/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /products/:id/image ────────────────────────────────────
router.delete('/:id/image', verifyToken, async (req, res) => {
  try {
    const { clause, params } = scopeClause(req);
    const scopedClause = shiftClause(clause, 1);

    const result = await db.query(
      `UPDATE products SET image_url = NULL
       WHERE id = $1 AND ${scopedClause} AND deleted_at IS NULL
       RETURNING id`,
      [req.params.id, ...params]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Produit introuvable' });
    res.json({ message: 'Image supprimée' });
  } catch (err) {
    console.error('DELETE /products/:id/image:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
