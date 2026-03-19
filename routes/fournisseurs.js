// routes/fournisseurs.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verify  = require('../middleware/auth');

// ─── GET /fournisseurs ─── Liste des fournisseurs
router.get('/', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT f.*,
              COUNT(c.id) AS nb_commandes,
              COALESCE(SUM(c.total), 0) AS total_commandes
       FROM fournisseurs f
       LEFT JOIN commandes c ON c.fournisseur_id = f.id AND c.user_id = f.user_id
       WHERE f.user_id = $1
       GROUP BY f.id
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /fournisseurs:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /fournisseurs/:id ─── Détail + commandes liées
router.get('/:id', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM fournisseurs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fournisseur introuvable' });

    const { rows: commandes } = await db.query(
      `SELECT * FROM commandes
       WHERE fournisseur_id = $1 AND user_id = $2
       ORDER BY created_at DESC`,
      [req.params.id, req.user.id]
    );

    res.json({ ...rows[0], commandes });
  } catch (err) {
    console.error('GET /fournisseurs/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /fournisseurs ─── Créer un fournisseur
router.post('/', verify, async (req, res) => {
  try {
    const { name, phone, email, address, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Le nom est requis' });

    const { rows } = await db.query(
      `INSERT INTO fournisseurs (user_id, name, phone, email, address, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, name, phone || null, email || null, address || null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /fournisseurs:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PATCH /fournisseurs/:id ─── Modifier
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
      `UPDATE fournisseurs SET ${set.join(', ')}
       WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Fournisseur introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /fournisseurs/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── DELETE /fournisseurs/:id ─── Supprimer
router.delete('/:id', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM fournisseurs WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fournisseur introuvable' });
    res.json({ message: 'Fournisseur supprimé' });
  } catch (err) {
    console.error('DELETE /fournisseurs/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
