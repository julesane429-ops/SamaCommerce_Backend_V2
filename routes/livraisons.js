// routes/livraisons.js — Livraisons de réapprovisionnement fournisseurs
// Table renommée : livraisons → restock_deliveries
//                  commandes  → restock_orders
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verify  = require('../middleware/auth');

// ─── GET /livraisons ─── Liste toutes les livraisons fournisseurs
router.get('/', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT l.*,
              c.status        AS commande_status,
              c.total         AS commande_total,
              c.expected_date,
              f.name          AS fournisseur_name
       FROM restock_deliveries l
       LEFT JOIN restock_orders c ON c.id = l.commande_id
       LEFT JOIN fournisseurs   f ON f.id = c.fournisseur_id
       WHERE l.user_id = $1
       ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /livraisons:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /livraisons/:id ─── Détail livraison
router.get('/:id', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT l.*,
              c.status        AS commande_status,
              c.total         AS commande_total,
              c.notes         AS commande_notes,
              c.expected_date,
              f.name          AS fournisseur_name,
              f.phone         AS fournisseur_phone
       FROM restock_deliveries l
       LEFT JOIN restock_orders c ON c.id = l.commande_id
       LEFT JOIN fournisseurs   f ON f.id = c.fournisseur_id
       WHERE l.id = $1 AND l.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });

    // Articles de la commande liée
    const { rows: items } = await db.query(
      `SELECT ci.*, p.name AS product_name
       FROM commande_items ci
       LEFT JOIN products p ON p.id = ci.product_id
       WHERE ci.commande_id = $1`,
      [rows[0].commande_id]
    );

    res.json({ ...rows[0], items });
  } catch (err) {
    console.error('GET /livraisons/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /livraisons ─── Créer une livraison liée à une commande fournisseur
router.post('/', verify, async (req, res) => {
  try {
    const { commande_id, tracking_note } = req.body;

    if (commande_id) {
      const { rows: cmd } = await db.query(
        'SELECT id FROM restock_orders WHERE id = $1 AND user_id = $2',
        [commande_id, req.user.id]
      );
      if (!cmd.length) return res.status(404).json({ error: 'Commande introuvable' });
    }

    const { rows } = await db.query(
      `INSERT INTO restock_deliveries (user_id, commande_id, tracking_note, status)
       VALUES ($1,$2,$3,'en_attente') RETURNING *`,
      [req.user.id, commande_id||null, tracking_note||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /livraisons:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PATCH /livraisons/:id ─── Mettre à jour statut / note
router.patch('/:id', verify, async (req, res) => {
  try {
    const allowed = ['status', 'tracking_note', 'delivered_at'];
    const set = [], values = [];
    let i = 1;

    // Auto-date si livraison confirmée
    if (req.body.status === 'livree' && !req.body.delivered_at) {
      req.body.delivered_at = new Date().toISOString();
    }

    for (const f of allowed) {
      if (req.body.hasOwnProperty(f)) { set.push(`${f} = $${i++}`); values.push(req.body[f]); }
    }
    if (!set.length) return res.status(400).json({ error: 'Aucun champ' });

    values.push(req.params.id, req.user.id);
    const { rows } = await db.query(
      `UPDATE restock_deliveries SET ${set.join(', ')}
       WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /livraisons/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── DELETE /livraisons/:id ───
router.delete('/:id', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM restock_deliveries WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });
    res.json({ message: 'Livraison supprimée' });
  } catch (err) {
    console.error('DELETE /livraisons/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
