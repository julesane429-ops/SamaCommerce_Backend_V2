const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

function clientOwner(req) {
  return {
    sql:    '(c.boutique_id = $1 OR (c.boutique_id IS NULL AND c.user_id = $2))',
    params: [req.user.boutique_id, req.user.id],
  };
}

// GET /clients
router.get('/', verifyToken, perm('clients'), async (req, res) => {
  try {
    const { sql, params } = clientOwner(req);
    const { rows } = await db.query(`
      SELECT c.*,
        COALESCE((
          SELECT SUM(s.total) FROM sales s
          WHERE s.user_id = c.user_id
            AND (s.client_id = c.id OR (s.client_id IS NULL AND s.client_name = c.name))
        ), 0) AS total_achats
      FROM clients c
      WHERE ${sql}
      ORDER BY c.name
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /clients:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /clients/:id
router.get('/:id', verifyToken, perm('clients'), async (req, res) => {
  try {
    const { sql, params } = clientOwner(req);
    const { rows: cRows } = await db.query(
      `SELECT * FROM clients c WHERE c.id = $${params.length + 1} AND ${sql}`,
      [...params, req.params.id]
    );
    if (!cRows.length) return res.status(404).json({ error: 'Client introuvable' });
    const client = cRows[0];

    const { rows: sales } = await db.query(`
      SELECT s.*, p.name AS product_name FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE s.user_id = $1
        AND (s.client_id = $2 OR (s.client_id IS NULL AND s.client_name = $3))
      ORDER BY s.created_at DESC
    `, [req.user.id, client.id, client.name]);

    const { rows: orders } = await db.query(`
      SELECT co.* FROM customer_orders co
      WHERE co.client_id = $1 AND co.user_id = $2
      ORDER BY co.created_at DESC LIMIT 10
    `, [client.id, req.user.id]);

    res.json({ ...client, sales, orders });
  } catch (err) {
    console.error('GET /clients/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /clients
router.post('/', verifyToken, perm('clients'), async (req, res) => {
  try {
    const { name, phone, email, address, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Le nom est requis' });

    // Vérifier doublon dans cette boutique
    const { sql, params } = clientOwner(req);
    const { rows: dup } = await db.query(
      `SELECT id FROM clients c WHERE LOWER(c.name) = LOWER($${params.length + 1}) AND ${sql}`,
      [...params, name.trim()]
    );
    if (dup.length) return res.status(409).json({ error: 'Ce client existe déjà' });

    const { rows } = await db.query(
      `INSERT INTO clients (user_id, boutique_id, name, phone, email, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.id, req.user.boutique_id || null,
       name.trim(), phone || null, email || null, address || null, notes || null]
    );

    // Lier les ventes anonymes existantes (même nom, même boutique)
    await db.query(
      `UPDATE sales SET client_id = $1
       WHERE user_id = $2 AND client_name = $3 AND client_id IS NULL`,
      [rows[0].id, req.user.id, name.trim()]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /clients:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /clients/:id
router.patch('/:id', verifyToken, perm('clients'), async (req, res) => {
  try {
    const fields  = ['name', 'phone', 'email', 'address', 'notes'];
    const set     = [];
    const values  = [];
    let i = 1;

    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body, f)) {
        values.push(req.body[f]);
        set.push(`${f} = $${i++}`);
      }
    }
    if (!set.length) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });

    const { sql, params } = clientOwner(req);
    // Re-alias params pour éviter conflit de numéros
    const idIdx    = i++;
    const bIdx     = i++;
    const uIdx     = i;

    const { rows } = await db.query(
      `UPDATE clients SET ${set.join(', ')}
       WHERE id = $${idIdx}
         AND (boutique_id = $${bIdx} OR (boutique_id IS NULL AND user_id = $${uIdx}))
       RETURNING *`,
      [...values, req.params.id, req.user.boutique_id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Client introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /clients/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /clients/:id
router.delete('/:id', verifyToken, perm('clients'), async (req, res) => {
  try {
    const { sql, params } = clientOwner(req);
    const { rows } = await db.query(
      `SELECT c.name FROM clients c WHERE c.id = $${params.length + 1} AND ${sql}`,
      [...params, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Client introuvable' });

    await db.query('UPDATE sales SET client_id = NULL WHERE client_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);

    await db.query('DELETE FROM clients WHERE id = $1', [req.params.id]);

    res.json({ message: 'Client supprimé' });
  } catch (err) {
    console.error('DELETE /clients/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /clients/:id/stats
router.get('/:id/stats', verifyToken, perm('clients'), async (req, res) => {
  try {
    const { sql, params } = clientOwner(req);
    const { rows: cRows } = await db.query(
      `SELECT * FROM clients c WHERE c.id = $${params.length + 1} AND ${sql}`,
      [...params, req.params.id]
    );
    if (!cRows.length) return res.status(404).json({ error: 'Client introuvable' });
    const client = cRows[0];

    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                         AS nb_achats,
        COALESCE(SUM(s.total), 0)::numeric                   AS total_depense,
        COUNT(*) FILTER (WHERE s.paid = false)::int           AS nb_credits,
        COALESCE(SUM(s.total) FILTER (WHERE s.paid = false), 0)::numeric AS montant_credit
      FROM sales s
      WHERE s.user_id = $1
        AND (s.client_id = $2 OR (s.client_id IS NULL AND s.client_name = $3))
    `, [req.user.id, client.id, client.name]);
    res.json({ ...rows[0], client_name: client.name });
  } catch (err) {
    console.error('GET /clients/:id/stats:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
