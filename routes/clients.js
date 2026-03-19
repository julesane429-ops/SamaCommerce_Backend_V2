// routes/clients.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verify  = require('../middleware/auth');

// ─── GET /clients ─── Liste des clients de l'utilisateur
router.get('/', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*,
              COUNT(s.id)        AS nb_achats,
              COALESCE(SUM(s.total), 0) AS total_achats
       FROM clients c
       LEFT JOIN sales s ON s.client_name = c.name AND s.user_id = c.user_id
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /clients:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /clients/:id ─── Détail d'un client + ses achats
router.get('/:id', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM clients WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Client introuvable' });

    // Historique achats du client (depuis sales)
    const { rows: achats } = await db.query(
      `SELECT s.*, p.name AS product_name
       FROM sales s
       LEFT JOIN products p ON p.id = s.product_id
       WHERE s.user_id = $1 AND s.client_name = $2
       ORDER BY s.created_at DESC`,
      [req.user.id, rows[0].name]
    );

    res.json({ ...rows[0], achats });
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

    const { rows } = await db.query(
      `INSERT INTO clients (user_id, name, phone, email, address, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, name, phone || null, email || null, address || null, notes || null]
    );
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
    if (!set.length) return res.status(400).json({ error: 'Aucun champ' });

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

module.exports = router;
