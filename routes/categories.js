const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

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
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /categories:', err.message);
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
      `SELECT id FROM categories WHERE id = $${params.length + 1} AND ${sql}`,
      [...params, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Catégorie non trouvée ou non autorisée' });

    // Vérifier produits liés dans cette boutique
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
    res.json({ success: true, message: 'Catégorie supprimée' });
  } catch (err) {
    console.error('DELETE /categories/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
