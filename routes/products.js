// routes/products.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');

// GET /products : Liste uniquement les produits de l'utilisateur connecté
router.get('/', verifyToken, async (req, res) => {
  console.log("👤 Utilisateur authentifié:", req.user);
  try {
    const userId = req.user.id;
    const result = await db.query(
  'SELECT * FROM products WHERE shop_id = $1 ORDER BY id DESC',
  [req.user.shop_id]
);

    console.log('📤 GET /products renvoie :', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur GET /products:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ GET /products/:id : Récupère un produit spécifique (sécurisé par user_id)
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const productId = req.params.id;

    const result = await db.query(
  'SELECT * FROM products WHERE id = $1 AND shop_id = $2',
  [productId, req.user.shop_id]
);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erreur GET /products/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// POST /products : Ajoute un produit lié à l'utilisateur connecté
router.post('/', verifyToken, async (req, res) => {
  try {
    console.log('📩 POST /products reçu :', req.body);
    console.log('👤 Utilisateur connecté :', req.user);

    const { name, category_id, scent, price, stock, price_achat } = req.body;
    const userId = req.user.id;

    const result = await db.query(
  `INSERT INTO products (name, category_id, scent, price, stock, price_achat, user_id, shop_id)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
   RETURNING *`,
  [
    name,
    category_id,
    scent,
    Number.isFinite(+price) ? +price : 0,
    Number.isFinite(+stock) ? +stock : 0,
    Number.isFinite(+price_achat) ? +price_achat : 0,
    req.user.id,
    req.user.shop_id
  ]
);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erreur POST /products:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /products/:id : Met à jour uniquement les produits appartenant à l'utilisateur
router.patch('/:id', verifyToken, async (req, res) => {
  try {
    console.log('📩 PATCH /products reçu :', req.body);

    const fields = ['name', 'category_id', 'scent', 'price', 'stock', 'price_achat'];
    const set = [];
    const values = [];
    let i = 1;

    for (const f of fields) {
      if (req.body.hasOwnProperty(f)) {
        if (['price', 'stock', 'price_achat', 'category_id'].includes(f)) {
          values.push(Number.isFinite(+req.body[f]) ? +req.body[f] : 0);
        } else {
          values.push(req.body[f]);
        }
        set.push(`${f} = $${i++}`);
      }
    }

    if (set.length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Ajout du filtre par user_id pour sécuriser la modification
    values.push(req.params.id);
values.push(req.user.shop_id);

    const result = await db.query(
      `UPDATE products SET ${set.join(', ')}
 WHERE id = $${i++} AND shop_id = $${i}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erreur PATCH /products/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /products/:id : Supprime uniquement les produits appartenant à l'utilisateur
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM products WHERE id = $1 AND shop_id = $2 RETURNING *',
      [req.params.id, req.user.shop_id] // ✅ correction ici
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produit introuvable ou non autorisé.' });
    }

    res.json({ message: 'Produit supprimé' });
  } catch (err) {
    console.error('Erreur DELETE /products/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
