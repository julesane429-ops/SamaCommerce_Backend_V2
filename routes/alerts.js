const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verify  = require('../middleware/auth');
const bf      = require('../middleware/boutiqueFilter');

// GET /alerts — alertes de la boutique active
router.get('/', verify, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'a');
    const { rows } = await db.query(
      `SELECT a.id, a.type, a.message, a.days, a.seen, a.ignored, a.archived, a.created_at
       FROM alerts a
       WHERE ${sql} AND a.archived = false
       ORDER BY a.created_at DESC`,
      p
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /alerts:', err.message);
    res.status(500).json({ error: 'Impossible de charger les alertes' });
  }
});

// PATCH /alerts/:id/seen
router.patch('/:id/seen', verify, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'a');
    const { rows } = await db.query(
      `UPDATE alerts a SET seen = true WHERE a.id = $${p.length+1} AND ${sql} RETURNING *`,
      [...p, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Alerte introuvable' });
    res.json({ message: 'Alerte vue', alert: rows[0] });
  } catch (err) {
    console.error('PATCH /alerts/:id/seen:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /alerts/:id/ignore
router.patch('/:id/ignore', verify, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'a');
    const { rows } = await db.query(
      `UPDATE alerts a SET ignored = true WHERE a.id = $${p.length+1} AND ${sql} RETURNING *`,
      [...p, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Alerte introuvable' });
    res.json({ message: 'Alerte ignorée', alert: rows[0] });
  } catch (err) {
    console.error('PATCH /alerts/:id/ignore:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /alerts/:id (archive)
router.delete('/:id', verify, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'a');
    const { rows } = await db.query(
      `UPDATE alerts a SET archived = true WHERE a.id = $${p.length+1} AND ${sql} RETURNING *`,
      [...p, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Alerte introuvable' });
    res.json({ message: 'Alerte fermée', alert: rows[0] });
  } catch (err) {
    console.error('DELETE /alerts/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
