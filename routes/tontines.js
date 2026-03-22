const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const verifyToken = require('../middleware/auth');

router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM tontines WHERE user_id = $1 ORDER BY created_date DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /tontines:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', verifyToken, async (req, res) => {
  const { name, type, amount, members } = req.body;
  if (!name || !amount) {
    return res.status(400).json({ error: 'Champs manquants' });
  }
  try {
    const result = await db.query(
      `INSERT INTO tontines (name, type, amount, members, user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, type, amount, members, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /tontines:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
