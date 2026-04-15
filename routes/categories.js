const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');
let logActivity;
try { logActivity = require('./activityLogs').logActivity; } catch { logActivity = async () => {}; }

function catOwner(req) {
  return {
    sql:    '(boutique_id = $1 OR (boutique_id IS NULL AND user_id = $2))',
    params: [req.user.boutique_id, req.user.id],
  };
}

// GET /categories
router.get('/', verifyToken, async (req, res) => {
  try {
    const { sql, params } = catOwner(req);
    const { rows } = await db.query(
      `SELECT id, name, user_id, emoji, couleur FROM categories WHERE ${sql} ORDER BY id`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /categories:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /categories
router.post('/', verifyToken, perm('categories'), async (req, res) => {
  try {
    const { name, emoji, couleur } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Le nom est requis' });

    const { rows } = await db.query(
      `INSERT INTO categories (name, user_id, boutique_id, emoji, couleur)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, user_id, boutique_id, emoji, couleur`,
      [name.trim(), req.user.id, req.user.boutique_id || null, emoji || '🏷️', couleur || null]
    );

    await logActivity(req, {
      action: 'ajout_categorie', entity_type: 'category',
      entity_id: rows[0].id, details: { name: name.trim(), emoji },
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /categories:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /categories/:id — Modifier une catégorie
router.patch('/:id', verifyToken, perm('categories'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' });

    const { name, emoji, couleur } = req.body;
    const { sql, params } = catOwner(req);

    // Vérifier propriété
    const { rows: existing } = await db.query(
      `SELECT * FROM categories WHERE id = $${params.length + 1} AND ${sql}`,
      [...params, id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Catégorie non trouvée' });

    const { rows } = await db.query(
      `UPDATE categories SET
         name    = COALESCE($1, name),
         emoji   = COALESCE($2, emoji),
         couleur = COALESCE($3, couleur),
         updated_at = NOW()
       WHERE id = $4
       RETURNING id, name, user_id, emoji, couleur`,
      [name?.trim() || null, emoji || null, couleur || null, id]
    );

    await logActivity(req, {
      action: 'modification_categorie', entity_type: 'category',
      entity_id: id,
      details: { before: existing[0], after: rows[0] },
    });

    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /categories/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /categories/:id
router.delete('/:id', verifyToken, perm('categories'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' });

    const { sql, params } = catOwner(req);

    const { rows } = await db.query(
      `SELECT id, name FROM categories WHERE id = $${params.length + 1} AND ${sql}`,
      [...params, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Catégorie non trouvée ou non autorisée' });

    const { sql: ps, params: pp } = catOwner(req);
    const { rows: prods } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM products
       WHERE category_id = $${pp.length + 1} AND ${ps} AND deleted_at IS NULL`,
      [...pp, id]
    );
    if (prods[0].cnt > 0) {
      return res.status(400).json({ error: 'Impossible de supprimer : catégorie avec produits.' });
    }

    await db.query('DELETE FROM categories WHERE id = $1', [id]);

    await logActivity(req, {
      action: 'suppression_categorie', entity_type: 'category',
      entity_id: id, details: { name: rows[0].name },
      severity: 'warning',
    });

    res.json({ success: true, message: 'Catégorie supprimée' });
  } catch (err) {
    console.error('DELETE /categories/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
