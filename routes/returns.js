// routes/returns.js — Gestion des retours produits
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const verifyToken = require('../middleware/auth');
const requirePlan = require('../middleware/checkSubscription');

// ── GET /returns ── Historique des retours
router.get('/', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT r.*, s.product_id, p.name AS product_name, p.price AS product_price
      FROM returns r
      JOIN sales s ON r.sale_id = s.id
      JOIN products p ON r.product_id = p.id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      LIMIT 100
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('GET /returns:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /returns ── Enregistrer un retour
router.post('/', verifyToken, requirePlan('credits'), async (req, res) => {
  const { sale_id, quantity, reason, refund_method } = req.body;

  if (!sale_id || !quantity) {
    return res.status(400).json({ error: 'sale_id et quantity sont requis' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Récupérer la vente originale
    const { rows: saleRows } = await client.query(
      'SELECT * FROM sales WHERE id = $1 AND user_id = $2',
      [sale_id, req.user.id]
    );
    if (!saleRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vente introuvable' });
    }
    const sale = saleRows[0];

    // 2. Vérifier quantité retournée ≤ quantité vendue
    // Calculer les retours déjà effectués sur cette vente
    const { rows: prevReturns } = await client.query(
      'SELECT COALESCE(SUM(quantity),0)::int AS total FROM returns WHERE sale_id = $1',
      [sale_id]
    );
    const alreadyReturned = prevReturns[0].total;
    const maxReturnable   = sale.quantity - alreadyReturned;

    if (quantity > maxReturnable) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Maximum ${maxReturnable} unité(s) retournable(s)`,
      });
    }

    // 3. Calcul du montant remboursé
    const pricePerUnit  = sale.total / sale.quantity;
    const refundAmount  = Math.round(pricePerUnit * quantity * 100) / 100;

    // 4. Insérer le retour
    const { rows: returnRows } = await client.query(`
      INSERT INTO returns
        (sale_id, product_id, user_id, quantity, reason, refund_method, refund_amount)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [sale_id, sale.product_id, req.user.id, quantity,
        reason || null, refund_method || 'avoir', refundAmount]);

    // 5. Recréditer le stock
    await client.query(
      'UPDATE products SET stock = stock + $1 WHERE id = $2 AND user_id = $3',
      [quantity, sale.product_id, req.user.id]
    );

    // 6. Mettre à jour la vente (réduire le total)
    const newTotal = Math.max(0, sale.total - refundAmount);
    const newQty   = sale.quantity - quantity;

    if (newQty === 0) {
      // Retour total → marquer la vente comme annulée
      await client.query(
        "UPDATE sales SET quantity = 0, total = 0, payment_method = 'retour' WHERE id = $1",
        [sale_id]
      );
    } else {
      await client.query(
        'UPDATE sales SET quantity = $1, total = $2 WHERE id = $3',
        [newQty, newTotal, sale_id]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: `Retour enregistré — ${refundAmount.toLocaleString('fr-FR')} F remboursés`,
      return: returnRows[0],
      stock_restitue: quantity,
      refund_amount:  refundAmount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /returns:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// ── GET /returns/stats ── Stats retours du jour/mois
router.get('/stats', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                              AS nb_retours,
        COALESCE(SUM(refund_amount), 0)::numeric                  AS total_rembourse,
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE)   AS retours_jour,
        COALESCE(SUM(refund_amount) FILTER (WHERE DATE(created_at) = CURRENT_DATE), 0) AS rembourse_jour
      FROM returns
      WHERE user_id = $1
    `, [req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /returns/stats:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
