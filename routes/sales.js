const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');

// ✅ GET toutes les ventes
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT s.*, p.name AS product_name
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE s.user_id = $1
      ORDER BY s.created_at DESC
    `, [req.user.id]);

    res.json(result.rows);
  } catch (err) {
    console.error("Erreur GET /sales :", err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ✅ POST nouvelle vente (gère aussi le crédit)
router.post('/', verifyToken, async (req, res) => {
  const { 
    product_id, 
    quantity, 
    payment_method, 
    client_name, 
    client_phone, 
    due_date,
    sale_type,       // 🆕 detail ou gros
    custom_price     // 🆕 prix négocié
  } = req.body;

  try {
    const result = await db.query(
      `SELECT price, price_retail, price_wholesale, stock, price_achat 
       FROM products 
       WHERE id = $1 AND user_id = $2`,
      [product_id, req.user.id]
    );

    const product = result.rows[0];

    if (!product) {
      return res.status(404).json({ error: 'Produit introuvable' });
    }

    if (product.stock < quantity) {
      return res.status(400).json({ error: 'Stock insuffisant' });
    }

    // 🔥 LOGIQUE DE PRIX
    let unit_price;

    if (custom_price && custom_price > 0) {
      unit_price = custom_price; // marchandage
    } else if (sale_type === 'gros') {
      unit_price = product.price_wholesale || product.price;
    } else {
      unit_price = product.price_retail || product.price;
    }

    const total = unit_price * quantity;

    const paid = (payment_method === "credit") ? false : true;

    const insert = await db.query(
      `INSERT INTO sales 
      (product_id, quantity, total, payment_method, user_id, client_name, client_phone, due_date, paid, unit_price, sale_type) 
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [
        product_id, 
        quantity, 
        total, 
        payment_method, 
        req.user.id, 
        client_name || null, 
        client_phone || null, 
        due_date || null, 
        paid,
        unit_price,
        sale_type || 'detail'
      ]
    );

    const newSale = insert.rows[0];

    // 🔄 MAJ STOCK
    await db.query(
      'UPDATE products SET stock = stock - $1 WHERE id = $2 AND user_id = $3',
      [quantity, product_id, req.user.id]
    );

    res.status(201).json(newSale);

  } catch (err) {
    console.error("Erreur POST /sales :", err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});



// ✅ PATCH modifier une vente (quantité, paiement, remboursement)
router.patch('/:id', verifyToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { quantity, payment_method, paid, repayment_method } = req.body;

  try {
    const venteResult = await db.query(
      'SELECT * FROM sales WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (venteResult.rowCount === 0) {
      return res.status(404).json({ error: 'Vente introuvable ou non autorisée' });
    }

    const vente = venteResult.rows[0];

    // ✅ Cas 1 : modification de la quantité
    if (quantity && quantity !== vente.quantity) {
      const productResult = await db.query(
        'SELECT price, stock FROM products WHERE id = $1 AND user_id = $2',
        [vente.product_id, req.user.id]
      );
      const product = productResult.rows[0];
      if (!product) return res.status(404).json({ error: 'Produit introuvable' });

      const diff = quantity - vente.quantity;
      if (product.stock < diff) return res.status(400).json({ error: 'Stock insuffisant' });

      await db.query(
        `UPDATE sales 
         SET quantity = $1, total = $2, 
             payment_method = COALESCE($3, payment_method), 
             paid = COALESCE($4, paid),
             repayment_method = COALESCE($5, repayment_method)
         WHERE id = $6 AND user_id = $7`,
        [quantity, product.price * quantity, payment_method, paid, repayment_method, id, req.user.id]
      );

      await db.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2 AND user_id = $3',
        [diff, vente.product_id, req.user.id]
      );
    } else {
      // ✅ Cas 2 : simple mise à jour paiement/remboursement
      await db.query(
        `UPDATE sales 
         SET payment_method = COALESCE($1, payment_method), 
             paid = COALESCE($2, paid),
             repayment_method = COALESCE($3, repayment_method)
         WHERE id = $4 AND user_id = $5`,
        [payment_method, paid, repayment_method, id, req.user.id]
      );
    }

    const updated = await db.query(
      'SELECT * FROM sales WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    res.json(updated.rows[0]);

  } catch (err) {
    console.error("Erreur PATCH /sales/:id :", err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});



// ✅ DELETE annuler une vente
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM sales WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Vente introuvable' });

    res.json({ message: 'Vente annulée' });
  } catch (err) {
    console.error("Erreur DELETE /sales/:id :", err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
