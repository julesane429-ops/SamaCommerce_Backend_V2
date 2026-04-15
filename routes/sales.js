const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');
let logActivity;
try { logActivity = require('./activityLogs').logActivity; } catch { logActivity = async () => {}; }

function saleOwnerClause(req, alias = 's') {
  const px  = alias ? `${alias}.` : '';
  const uid = req.user.id;
  const bid = req.user.boutique_id || null;
  if (!bid) {
    return { sql: `${px}user_id = $1`, params: [uid] };
  }
  return {
    sql: `(${px}boutique_id = $1 OR (${px}boutique_id IS NULL AND ${px}user_id = $2))`,
    params: [bid, uid],
  };
}

// ── GET /sales ──
router.get('/', verifyToken, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit || '200')));
    const offset = (page - 1) * limit;
    const days   = parseInt(req.query.days || '0');

    const dateClause   = days > 0 ? `AND s.created_at >= NOW() - INTERVAL '${days} days'` : '';
    const cursor       = parseInt(req.query.cursor || '0');
    const cursorClause = cursor > 0 ? `AND s.id < ${cursor}` : '';

    const { sql, params } = saleOwnerClause(req);

    const limitPos  = params.length + 1;
    const offsetPos = params.length + 2;
    const { rows } = await db.query(`
      SELECT s.*, p.name AS product_name, s.payment_details
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE ${sql}
        ${dateClause}
        ${cursorClause}
      ORDER BY s.created_at DESC
      LIMIT $${limitPos} OFFSET $${offsetPos}
    `, [...params, limit, offset]);

    res.json(rows);
  } catch (err) {
    console.error('GET /sales:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /sales ── (avec support paiement mixte)
router.post('/', verifyToken, perm('vente'), async (req, res) => {
  const {
    product_id, quantity, payment_method,
    payment_details,  // NOUVEAU : { especes: 3000, wave: 2000 }
    client_name, client_phone, due_date, client_id
  } = req.body;

  try {
    const { sql, params } = saleOwnerClause(req, 'p');
    const { rows: pRows } = await db.query(
      `SELECT price, stock FROM products p WHERE id = $${params.length+1} AND ${sql} AND deleted_at IS NULL`,
      [...params, product_id]
    );
    const product = pRows[0];
    if (!product) return res.status(404).json({ error: 'Produit introuvable' });
    if (product.stock < quantity) return res.status(400).json({ error: 'Stock insuffisant' });

    const total = product.price * quantity;
    const paid  = payment_method !== 'credit';

    // Déterminer la méthode à stocker
    // Si payment_details est fourni, c'est un paiement mixte
    const finalMethod  = payment_details ? 'mixte' : payment_method;
    const finalDetails = payment_details ? JSON.stringify(payment_details) : null;

    const { rows } = await db.query(
      `INSERT INTO sales
         (product_id, quantity, total, payment_method, payment_details, user_id, boutique_id,
          client_name, client_phone, client_id, due_date, paid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [product_id, quantity, total, finalMethod, finalDetails,
       req.user.id, req.user.boutique_id || null,
       client_name || null, client_phone || null, client_id || null,
       due_date || null, paid]
    );

    // Décrémenter le stock
    await db.query(
      'UPDATE products SET stock = stock - $1 WHERE id = $2 AND user_id = $3',
      [quantity, product_id, req.user.id]
    );

    // Log d'activité
    await logActivity(req, {
      action: 'vente',
      entity_type: 'sale',
      entity_id: rows[0].id,
      details: {
        product_id,
        quantity,
        total,
        payment_method: finalMethod,
        payment_details: payment_details || null,
      },
      severity: total >= 50000 ? 'warning' : 'info',
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /sales:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /sales/:id ──
router.patch('/:id', verifyToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { quantity, payment_method, paid, repayment_method } = req.body;

  try {
    const { sql, params } = saleOwnerClause(req);
    const { rows } = await db.query(
      `SELECT * FROM sales s WHERE s.id = $${params.length+1} AND ${sql}`,
      [...params, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vente introuvable ou non autorisée' });
    const vente = rows[0];

    if (quantity && quantity !== vente.quantity) {
      const { rows: pRows } = await db.query(
        'SELECT price, stock FROM products WHERE id = $1 AND user_id = $2',
        [vente.product_id, req.user.id]
      );
      if (!pRows.length) return res.status(404).json({ error: 'Produit introuvable' });
      const product = pRows[0];
      const diff = quantity - vente.quantity;
      if (product.stock < diff) return res.status(400).json({ error: 'Stock insuffisant' });

      await db.query(
        `UPDATE sales SET quantity=$1, total=$2,
           payment_method=COALESCE($3,payment_method),
           paid=COALESCE($4,paid),
           repayment_method=COALESCE($5,repayment_method)
         WHERE id=$6`,
        [quantity, product.price * quantity, payment_method, paid, repayment_method, id]
      );
      await db.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2 AND user_id = $3',
        [diff, vente.product_id, req.user.id]
      );
    } else {
      await db.query(
        `UPDATE sales SET
           payment_method=COALESCE($1,payment_method),
           paid=COALESCE($2,paid),
           repayment_method=COALESCE($3,repayment_method)
         WHERE id=$4`,
        [payment_method, paid, repayment_method, id]
      );
    }

    // Log modification
    await logActivity(req, {
      action: 'modification_vente',
      entity_type: 'sale',
      entity_id: id,
      details: { quantity, payment_method, paid },
      severity: 'warning',
    });

    const { rows: updated } = await db.query(
      `SELECT s.*, p.name AS product_name FROM sales s
       JOIN products p ON s.product_id = p.id WHERE s.id = $1`,
      [id]
    );
    res.json(updated[0]);
  } catch (err) {
    console.error('PATCH /sales/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /sales/:id ──
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { sql, params } = saleOwnerClause(req);
    const { rows } = await db.query(
      `SELECT * FROM sales s WHERE s.id = $${params.length+1} AND ${sql}`,
      [...params, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vente introuvable' });
    const vente = rows[0];

    await db.query('DELETE FROM sales WHERE id = $1', [req.params.id]);

    if (vente.payment_method !== 'retour') {
      await db.query(
        'UPDATE products SET stock = stock + $1 WHERE id = $2 AND user_id = $3',
        [vente.quantity, vente.product_id, req.user.id]
      );
    }

    // Log suppression (critique)
    await logActivity(req, {
      action: 'suppression_vente',
      entity_type: 'sale',
      entity_id: parseInt(req.params.id),
      details: {
        product_name: vente.product_name,
        total: vente.total,
        payment_method: vente.payment_method,
      },
      severity: 'critical',
    });

    res.json({ message: 'Vente annulée', restored_qty: vente.quantity });
  } catch (err) {
    console.error('DELETE /sales/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /sales/:id/partial-payment ──
router.patch('/:id/partial-payment', verifyToken, async (req, res) => {
  const { amount, payment_method } = req.body;
  if (!amount || isNaN(+amount) || +amount <= 0)
    return res.status(400).json({ error: 'Montant invalide' });

  try {
    const { sql, params } = saleOwnerClause(req);
    const { rows } = await db.query(
      `SELECT * FROM sales s WHERE s.id = $${params.length+1} AND ${sql}`,
      [...params, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vente introuvable' });
    const vente = rows[0];
    if (vente.paid) return res.status(400).json({ error: 'Crédit déjà entièrement remboursé' });
    if (vente.payment_method !== 'credit') return res.status(400).json({ error: 'Cette vente n\'est pas un crédit' });

    const alreadyPaid = parseFloat(vente.amount_paid) || 0;
    const newPaid     = parseFloat((alreadyPaid + parseFloat(amount)).toFixed(2));
    const total       = parseFloat(vente.total) || 0;
    const remaining   = parseFloat((total - newPaid).toFixed(2));

    if (newPaid > total) return res.status(400).json({
      error: `Montant trop élevé. Restant dû : ${(total - alreadyPaid).toLocaleString('fr-FR')} F`
    });

    const isFullyPaid = remaining <= 0;
    const { rows: updated } = await db.query(
      `UPDATE sales SET amount_paid=$1, paid=$2, repayment_method=COALESCE($3,repayment_method)
       WHERE id=$4 RETURNING *`,
      [newPaid, isFullyPaid, payment_method || null, req.params.id]
    );

    // Log remboursement
    await logActivity(req, {
      action: isFullyPaid ? 'credit_rembourse' : 'paiement_partiel',
      entity_type: 'sale',
      entity_id: parseInt(req.params.id),
      details: { amount, total, remaining: Math.max(0, remaining) },
      severity: 'info',
    });

    res.json({
      sale: updated[0], amount_paid: newPaid,
      remaining: Math.max(0, remaining), fully_paid: isFullyPaid,
      message: isFullyPaid
        ? '✅ Crédit entièrement remboursé'
        : `💳 Paiement partiel — Reste : ${Math.max(0, remaining).toLocaleString('fr-FR')} F`,
    });
  } catch (err) {
    console.error('PATCH /sales/:id/partial-payment:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
