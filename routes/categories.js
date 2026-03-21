const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

// GET : Liste catégories utilisateur
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, user_id, emoji, couleur FROM categories WHERE user_id = $1 ORDER BY id',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur lors de la récupération des catégories:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST : Créer catégorie
router.post('/', verifyToken, perm('categories'), async (req, res) => {
  try {
    const { name, emoji, couleur } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Le nom de la catégorie est requis' });
    }

    const result = await db.query(
      `INSERT INTO categories (name, user_id, emoji, couleur) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, name, user_id, emoji, couleur`,
      [name.trim(), req.user.id, emoji || '🏷️', couleur || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erreur POST /categories:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// DELETE : Supprimer catégorie utilisateur
router.delete('/:id', verifyToken, perm('categories'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' });

    // Vérifier si la catégorie appartient à l’utilisateur
    const catCheck = await db.query(
      'SELECT * FROM categories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (catCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Catégorie non trouvée ou non autorisée' });
    }

    // Vérifier s'il y a des produits liés
    const prodCheck = await db.query(
      'SELECT COUNT(*) FROM products WHERE category_id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (parseInt(prodCheck.rows[0].count, 10) > 0) {
      return res.status(400).json({ error: 'Impossible de supprimer : catégorie avec produits.' });
    }

    // Supprimer
    await db.query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    res.json({ success: true, message: 'Catégorie supprimée avec succès' });
  } catch (err) {
    console.error('Erreur DELETE /categories/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
