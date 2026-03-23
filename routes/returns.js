const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');
const requirePlan = require('../middleware/checkSubscription');
const bf          = require('../middleware/boutiqueFilter');

// GET /returns
router.get('/', verifyToken, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'r');
    const { rows } = await db.query(`
      SELECT r.*, p.name AS product_name, p.price AS product_price
      FROM returns r
      JOIN products p ON r.product_id = p.id
      WHERE ${sql}
      ORDER BY r.created_at DESC LIMIT 100
    `, p);
    res.json(rows);
  } catch (err) {
    console.error('GET /returns:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /returns/stats
router.get('/stats', verifyToken, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'r');
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                                             AS nb_retours,
        COALESCE(SUM(refund_amount), 0)::numeric                                 AS total_rembourse,
        COUNT(*) FILTER (WHERE DATE(r.created_at) = CURRENT_DATE)::int           AS retours_jour,
        COALESCE(SUM(refund_amount) FILTER (WHERE DATE(r.created_at) = CURRENT_DATE), 0) AS rembourse_jour
      FROM returns r WHERE ${sql}
    `, p);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /returns/stats:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /returns
router.post('/', verifyToken, requirePlan('credits'), async (req, res) => {
  const { sale_id, quantity, reason, refund_method } = req.body;
  if (!sale_id || !quantity) return res.status(400).json({ error: 'sale_id et quantity requis' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { sql, p, bid, uid } = bf(req, 's');

    // Vente appartenant à cette boutique
    const { rows: sRows } = await client.query(
      `SELECT * FROM sales s WHERE s.id = $3 AND ${sql}`,
      [...p, sale_id]
    );
    if (!sRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vente introuvable' });
    }
    const sale = sRows[0];

    const { rows: prev } = await client.query(
      'SELECT COALESCE(SUM(quantity),0)::int AS total FROM returns WHERE sale_id = $1',
      [sale_id]
    );
    const maxReturnable = sale.quantity - prev[0].total;
    if (quantity > maxReturnable) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Maximum ${maxReturnable} unité(s) retournable(s)` });
    }

    const refundAmount = Math.round((sale.total / sale.quantity) * quantity * 100) / 100;

    const { rows: ret } = await client.query(`
      INSERT INTO returns (sale_id, product_id, user_id, boutique_id, quantity, reason, refund_method, refund_amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [sale_id, sale.product_id, uid, bid || null, quantity, reason || null, refund_method || 'avoir', refundAmount]);

    // Recréditer le stock
    await client.query(
      'UPDATE products SET stock = stock + $1 WHERE id = $2',
      [quantity, sale.product_id]
    );

    // Mettre à jour la vente
    const newQty = sale.quantity - quantity;
    if (newQty === 0) {
      await client.query(
        "UPDATE sales SET quantity=0, total=0, payment_method='retour' WHERE id=$1", [sale_id]
      );
    } else {
      await client.query(
        'UPDATE sales SET quantity=$1, total=$2 WHERE id=$3',
        [newQty, Math.max(0, sale.total - refundAmount), sale_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      message:        `Retour enregistré — ${refundAmount.toLocaleString('fr-FR')} F remboursés`,
      return:         ret[0],
      stock_restitue: quantity,
      refund_amount:  refundAmount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /returns:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

module.exports = router;
