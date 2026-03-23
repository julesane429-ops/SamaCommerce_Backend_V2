const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');
const bf          = require('../middleware/boutiqueFilter');

router.get('/', verifyToken, async (req, res) => {
  try {
    const { status } = req.query;
    const { sql, p } = bf(req, 'co');
    const statusClause = status && status !== 'tous' ? `AND co.status=$${p.length+1}` : '';
    const params = status && status !== 'tous' ? [...p, status] : p;

    const { rows } = await db.query(`
      SELECT co.*, c.name AS client_name, c.phone AS client_phone,
             COUNT(coi.id)::int AS nb_items,
             d.id AS delivery_id, d.status AS delivery_status, dm.name AS deliveryman_name
      FROM customer_orders co
      LEFT JOIN clients    c   ON co.client_id = c.id
      LEFT JOIN customer_order_items coi ON coi.order_id = co.id
      LEFT JOIN deliveries d   ON d.order_id = co.id
      LEFT JOIN deliverymen dm ON d.deliveryman_id = dm.id
      WHERE ${sql} ${statusClause}
      GROUP BY co.id, c.name, c.phone, d.id, d.status, dm.name
      ORDER BY co.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /customer-orders:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'co');
    const { rows: orders } = await db.query(`
      SELECT co.*, c.name AS client_name, c.phone AS client_phone, c.address AS client_address
      FROM customer_orders co LEFT JOIN clients c ON co.client_id=c.id
      WHERE co.id=$3 AND ${sql}
    `, [...p, req.params.id]);
    if (!orders.length) return res.status(404).json({ error: 'Commande introuvable' });

    const { rows: items } = await db.query(`
      SELECT coi.*, p.name AS product_name, p.price, p.stock, p.image_url
      FROM customer_order_items coi JOIN products p ON coi.product_id=p.id
      WHERE coi.order_id=$1
    `, [req.params.id]);

    const { rows: delivery } = await db.query(`
      SELECT d.*, dm.name AS deliveryman_name, dm.phone AS deliveryman_phone
      FROM deliveries d LEFT JOIN deliverymen dm ON d.deliveryman_id=dm.id
      WHERE d.order_id=$1
    `, [req.params.id]);

    res.json({ ...orders[0], items, delivery: delivery[0]||null });
  } catch (err) {
    console.error('GET /customer-orders/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', verifyToken, async (req, res) => {
  const { client_id, items, delivery_address, delivery_date, notes,
          payment_status='a_encaisser', payment_method } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Au moins un article requis' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { bid, uid } = bf(req);
    let total = 0;

    for (const item of items) {
      const { rows } = await client.query(
        'SELECT price, stock, stock_reserved FROM products WHERE id=$1 AND user_id=$2',
        [item.product_id, uid]
      );
      if (!rows.length) throw new Error(`Produit ${item.product_id} introuvable`);
      const p = rows[0];
      if ((p.stock - (p.stock_reserved||0)) < item.quantity) throw new Error(`Stock insuffisant`);
      total += p.price * item.quantity;
      item.prix_unitaire = p.price;
    }

    const { rows: order } = await client.query(`
      INSERT INTO customer_orders (user_id, boutique_id, client_id, total, delivery_address,
        delivery_date, notes, payment_status, payment_method)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [uid, bid||null, client_id||null, total, delivery_address||null,
        delivery_date||null, notes||null, payment_status, payment_method||null]);

    for (const item of items) {
      await client.query(
        'INSERT INTO customer_order_items (order_id, product_id, quantity, prix_unitaire) VALUES ($1,$2,$3,$4)',
        [order[0].id, item.product_id, item.quantity, item.prix_unitaire]
      );
      await client.query('UPDATE products SET stock_reserved=stock_reserved+$1 WHERE id=$2', [item.quantity, item.product_id]);
    }

    await client.query('COMMIT');
    res.status(201).json({ ...order[0], items });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /customer-orders:', err.message);
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

router.patch('/:id/confirm', verifyToken, async (req, res) => {
  const dbClient = await db.connect();
  try {
    await dbClient.query('BEGIN');
    const { sql, p, bid, uid } = bf(req, 'co');
    const { rows } = await dbClient.query(
      `UPDATE customer_orders co SET status='confirmee', confirmed_at=NOW()
       WHERE co.id=$3 AND ${sql} AND co.status='recue' RETURNING *`,
      [...p, req.params.id]
    );
    if (!rows.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Commande introuvable ou déjà confirmée' }); }

    const { rows: delivery } = await dbClient.query(
      'INSERT INTO deliveries (user_id, boutique_id, order_id) VALUES ($1,$2,$3) RETURNING *',
      [uid, bid||null, req.params.id]
    );
    await dbClient.query('COMMIT');
    res.json({ order: rows[0], delivery: delivery[0] });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('PATCH /confirm:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { dbClient.release(); }
});

router.patch('/:id', verifyToken, async (req, res) => {
  const allowed = ['status','payment_status','payment_method','delivery_address','delivery_date','notes'];
  const fields = [], values = [];
  let i = 1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key}=$${i++}`); values.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Aucun champ' });

  try {
    if (req.body.status === 'annulee') {
      const { rows: items } = await db.query('SELECT product_id, quantity FROM customer_order_items WHERE order_id=$1', [req.params.id]);
      for (const it of items) {
        await db.query('UPDATE products SET stock_reserved=GREATEST(0,stock_reserved-$1) WHERE id=$2', [it.quantity, it.product_id]);
      }
    }
    const { uid } = bf(req);
    values.push(req.params.id, uid);
    const { rows } = await db.query(
      `UPDATE customer_orders SET ${fields.join(',')}
       WHERE id=$${i} AND user_id=$${i+1} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Commande introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /customer-orders/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/:id', verifyToken, async (req, res) => {
  const dbClient = await db.connect();
  try {
    await dbClient.query('BEGIN');
    const { sql, p } = bf(req, 'co');
    const { rows: chk } = await dbClient.query(
      `SELECT id FROM customer_orders co WHERE co.id=$3 AND ${sql}`, [...p, req.params.id]
    );
    if (!chk.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Commande introuvable' }); }

    const { rows: items } = await dbClient.query('SELECT product_id, quantity FROM customer_order_items WHERE order_id=$1', [req.params.id]);
    for (const it of items) {
      await dbClient.query('UPDATE products SET stock_reserved=GREATEST(0,stock_reserved-$1) WHERE id=$2', [it.quantity, it.product_id]);
    }
    await dbClient.query('DELETE FROM customer_orders WHERE id=$1', [req.params.id]);
    await dbClient.query('COMMIT');
    res.json({ message: 'Commande supprimée' });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('DELETE /customer-orders:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { dbClient.release(); }
});

module.exports = router;
