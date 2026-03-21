// routes/clients.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verify  = require('../middleware/auth');

// ─── GET /clients ─── Liste des clients
router.get('/', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*,
              COUNT(DISTINCT s.id)::int                                      AS nb_achats,
              COALESCE(SUM(s.total), 0)::numeric                             AS total_achats,
              COUNT(DISTINCT s.id) FILTER (WHERE s.paid = false)::int        AS credits_ouverts,
              COALESCE(SUM(s.total) FILTER (WHERE s.paid = false), 0)        AS credits_montant
       FROM clients c
       LEFT JOIN sales s ON (
         s.client_id = c.id
         OR (s.client_id IS NULL AND s.client_name = c.name AND s.user_id = c.user_id)
       )
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY total_achats DESC, c.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /clients:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /clients/:id ─── Détail + historique achats + commandes
router.get('/:id', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM clients WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Client introuvable' });
    const client = rows[0];

    // Historique ventes : client_id en priorité, client_name en fallback
    const { rows: achats } = await db.query(
      `SELECT s.*, p.name AS product_name
       FROM sales s
       LEFT JOIN products p ON p.id = s.product_id
       WHERE s.user_id = $1
         AND (s.client_id = $2 OR (s.client_id IS NULL AND s.client_name = $3))
       ORDER BY s.created_at DESC`,
      [req.user.id, client.id, client.name]
    );

    // Commandes clients liées
    let commandes = [];
    try {
      const r = await db.query(
        `SELECT co.*, COUNT(coi.id)::int AS nb_items
         FROM customer_orders co
         LEFT JOIN customer_order_items coi ON coi.order_id = co.id
         WHERE co.client_id = $1 AND co.user_id = $2
         GROUP BY co.id
         ORDER BY co.created_at DESC LIMIT 10`,
        [client.id, req.user.id]
      );
      commandes = r.rows;
    } catch {} // table peut ne pas encore exister

    res.json({ ...client, achats, commandes });
  } catch (err) {
    console.error('GET /clients/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /clients ─── Créer un client
router.post('/', verify, async (req, res) => {
  try {
    const { name, phone, email, address, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Le nom est requis' });

    // Vérifier doublon
    const dup = await db.query(
      'SELECT id FROM clients WHERE user_id = $1 AND LOWER(name) = LOWER($2)',
      [req.user.id, name]
    );
    if (dup.rows.length) {
      return res.status(400).json({ error: `Un client nommé "${name}" existe déjà` });
    }

    const { rows } = await db.query(
      `INSERT INTO clients (user_id, name, phone, email, address, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, name, phone||null, email||null, address||null, notes||null]
    );

    // Lier automatiquement les ventes existantes portant ce nom
    await db.query(
      `UPDATE sales SET client_id = $1
       WHERE user_id = $2 AND client_name = $3 AND client_id IS NULL`,
      [rows[0].id, req.user.id, name]
    ).catch(() => {});

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /clients:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PATCH /clients/:id ─── Modifier un client
router.patch('/:id', verify, async (req, res) => {
  try {
    const fields = ['name', 'phone', 'email', 'address', 'notes'];
    const set = [], values = [];
    let i = 1;
    for (const f of fields) {
      if (req.body.hasOwnProperty(f)) {
        set.push(`${f} = $${i++}`);
        values.push(req.body[f]);
      }
    }
    if (!set.length) return res.status(400).json({ error: 'Aucun champ à modifier' });

    values.push(req.params.id, req.user.id);
    const { rows } = await db.query(
      `UPDATE clients SET ${set.join(', ')}
       WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Client introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /clients/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── DELETE /clients/:id ─── Supprimer un client
router.delete('/:id', verify, async (req, res) => {
  try {
    // Délier les ventes (le champ client_name reste pour la trace)
    await db.query(
      'UPDATE sales SET client_id = NULL WHERE client_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    ).catch(() => {});

    const { rows } = await db.query(
      'DELETE FROM clients WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Client introuvable' });
    res.json({ message: 'Client supprimé' });
  } catch (err) {
    console.error('DELETE /clients/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /clients/:id/stats ─── Stats rapides
router.get('/:id/stats', verify, async (req, res) => {
  try {
    const { rows: nameRows } = await db.query(
      'SELECT name FROM clients WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!nameRows.length) return res.status(404).json({ error: 'Client introuvable' });

    const { rows } = await db.query(
      `SELECT
         COUNT(*)::int                                                       AS nb_achats,
         COALESCE(SUM(total), 0)::numeric                                    AS ca_total,
         COALESCE(SUM(total) FILTER (WHERE paid = true),  0)::numeric        AS ca_encaisse,
         COALESCE(SUM(total) FILTER (WHERE paid = false), 0)::numeric        AS credits_ouverts,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS achats_30j,
         MAX(created_at)                                                     AS dernier_achat
       FROM sales
       WHERE user_id = $1
         AND (client_id = $2 OR (client_id IS NULL AND client_name = $3))`,
      [req.user.id, req.params.id, nameRows[0].name]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /clients/:id/stats:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
