const express     = require('express');
const router      = express.Router();
const router2     = express.Router(); // deliverymen
const db          = require('../db');
const verifyToken = require('../middleware/auth');
const bf          = require('../middleware/boutiqueFilter');

// ════════════════ DELIVERIES ════════════════

router.get('/', verifyToken, async (req, res) => {
  try {
    const { status } = req.query;
    const { sql, p } = bf(req, 'd');
    const statusClause = status && status !== 'tous' ? `AND d.status=$${p.length+1}` : '';
    const params = status && status !== 'tous' ? [...p, status] : p;

    const { rows } = await db.query(`
      SELECT d.*, co.delivery_address, co.delivery_date, co.total AS order_total,
             co.payment_status, c.name AS client_name, c.phone AS client_phone,
             dm.name AS deliveryman_name, dm.phone AS deliveryman_phone, dm.status AS deliveryman_status
      FROM deliveries d
      JOIN customer_orders co ON d.order_id = co.id
      LEFT JOIN clients     c  ON co.client_id      = c.id
      LEFT JOIN deliverymen dm ON d.deliveryman_id  = dm.id
      WHERE ${sql} ${statusClause}
      ORDER BY d.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /deliveries:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'd');
    const { rows } = await db.query(`
      SELECT d.*, co.delivery_address, co.delivery_date, co.total AS order_total,
             co.payment_status, co.payment_method, co.notes AS order_notes,
             c.name AS client_name, c.phone AS client_phone, c.address AS client_address,
             dm.name AS deliveryman_name, dm.phone AS deliveryman_phone, dm.zone AS deliveryman_zone
      FROM deliveries d
      JOIN customer_orders co ON d.order_id = co.id
      LEFT JOIN clients     c  ON co.client_id     = c.id
      LEFT JOIN deliverymen dm ON d.deliveryman_id = dm.id
      WHERE d.id=$${p.length+1} AND ${sql}
    `, [...p, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });

    const { rows: items } = await db.query(`
      SELECT coi.*, p.name AS product_name, p.image_url
      FROM customer_order_items coi JOIN products p ON coi.product_id=p.id
      WHERE coi.order_id=$1
    `, [rows[0].order_id]);
    res.json({ ...rows[0], items });
  } catch (err) {
    console.error('GET /deliveries/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.patch('/:id/assign', verifyToken, async (req, res) => {
  const { deliveryman_id } = req.body;
  if (!deliveryman_id) return res.status(400).json({ error: 'deliveryman_id requis' });
  try {
    const { sql, p } = bf(req, 'd');
    const { rows } = await db.query(
      `UPDATE deliveries d SET deliveryman_id=$${p.length+1}, status='assignee' WHERE d.id=$${p.length+2} AND ${sql} RETURNING *`,
      [...p, deliveryman_id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });
    await db.query("UPDATE deliverymen SET status='en_course' WHERE id=$1", [deliveryman_id]);
    await db.query("UPDATE customer_orders SET status='en_livraison' WHERE id=$1", [rows[0].order_id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /deliveries/:id/assign:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.patch('/:id/depart', verifyToken, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'd');
    const { rows } = await db.query(
      `UPDATE deliveries d SET status='en_route', pickup_time=NOW() WHERE d.id=$${p.length+1} AND ${sql} RETURNING *`,
      [...p, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /deliveries/:id/depart:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.patch('/:id/livree', verifyToken, async (req, res) => {
  const dbClient = await db.connect();
  try {
    await dbClient.query('BEGIN');
    const { sql, p, uid, bid } = bf(req, 'd');
    const { rows: del } = await dbClient.query(`
      SELECT d.*, co.client_id, co.payment_status, co.payment_method, co.total
      FROM deliveries d JOIN customer_orders co ON d.order_id=co.id
      WHERE d.id=$${p.length+1} AND ${sql}
    `, [...p, req.params.id]);
    if (!del.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Livraison introuvable' }); }
    const delivery = del[0];

    const { rows: items } = await dbClient.query('SELECT * FROM customer_order_items WHERE order_id=$1', [delivery.order_id]);
    for (const it of items) {
      await dbClient.query('UPDATE products SET stock=stock-$1, stock_reserved=GREATEST(0,stock_reserved-$1) WHERE id=$2', [it.quantity, it.product_id]);
    }

    if (delivery.payment_status === 'a_encaisser') {
      for (const it of items) {
        await dbClient.query(`
          INSERT INTO sales (product_id, quantity, total, payment_method, user_id, boutique_id, client_id, paid)
          VALUES ($1,$2,$3,$4,$5,$6,$7,true)
        `, [it.product_id, it.quantity, it.prix_unitaire*it.quantity,
            delivery.payment_method||'especes', uid, bid||null, delivery.client_id]);
      }
    }

    await dbClient.query("UPDATE deliveries SET status='livree', delivered_at=NOW() WHERE id=$1", [req.params.id]);
    await dbClient.query("UPDATE customer_orders SET status='livree', delivered_at=NOW(), payment_status='paye' WHERE id=$1", [delivery.order_id]);
    if (delivery.deliveryman_id) {
      await dbClient.query("UPDATE deliverymen SET status='disponible' WHERE id=$1", [delivery.deliveryman_id]);
    }

    await dbClient.query('COMMIT');
    res.json({ message: 'Livraison confirmée — stock débité' });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('PATCH /deliveries/:id/livree:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { dbClient.release(); }
});

router.patch('/:id', verifyToken, async (req, res) => {
  const { tracking_note, status } = req.body;
  const fields = [], values = [];
  let i = 1;
  if (tracking_note !== undefined) { fields.push(`tracking_note=$${i++}`); values.push(tracking_note); }
  if (status !== undefined)        { fields.push(`status=$${i++}`);        values.push(status); }
  if (!fields.length) return res.status(400).json({ error: 'Rien à mettre à jour' });
  try {
    const { uid } = bf(req);
    values.push(req.params.id, uid);
    const { rows } = await db.query(
      `UPDATE deliveries SET ${fields.join(',')}
       WHERE id=$${i} AND user_id=$${i+1} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /deliveries/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ════════════════ DELIVERYMEN ════════════════

router2.get('/', verifyToken, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'dm');
    const { rows } = await db.query(`
      SELECT dm.*,
        COUNT(d.id)::int                                  AS nb_livraisons,
        COUNT(d.id) FILTER (WHERE d.status='livree')::int AS nb_livrees,
        COUNT(d.id) FILTER (WHERE d.status='en_route')::int AS en_cours
      FROM deliverymen dm LEFT JOIN deliveries d ON d.deliveryman_id=dm.id
      WHERE ${sql}
      GROUP BY dm.id ORDER BY dm.name
    `, p);
    res.json(rows);
  } catch (err) {
    console.error('GET /deliverymen:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router2.post('/', verifyToken, async (req, res) => {
  const { name, phone, zone, tarif_livraison, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  try {
    const { bid, uid } = bf(req);
    const { rows } = await db.query(
      'INSERT INTO deliverymen (user_id, boutique_id, name, phone, zone, tarif_livraison, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [uid, bid||null, name, phone||null, zone||null, tarif_livraison||0, notes||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /deliverymen:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router2.patch('/:id', verifyToken, async (req, res) => {
  const allowed = ['name','phone','zone','tarif_livraison','status','notes'];
  const fields = [], values = [];
  let i = 1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key}=$${i++}`); values.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Rien à mettre à jour' });
  try {
    const { uid } = bf(req);
    values.push(req.params.id, uid);
    const { rows } = await db.query(
      `UPDATE deliverymen SET ${fields.join(',')}
       WHERE id=$${i} AND user_id=$${i+1} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Livreur introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /deliverymen/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router2.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'dm');
    const { rowCount } = await db.query(`DELETE FROM deliverymen dm WHERE dm.id=$${p.length+1} AND ${sql}`, [...p, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Livreur introuvable' });
    res.json({ message: 'Livreur supprimé' });
  } catch (err) {
    console.error('DELETE /deliverymen/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router2.get('/:id/livraisons', verifyToken, async (req, res) => {
  try {
    const { sql, p } = bf(req, 'd');
    const { rows } = await db.query(`
      SELECT d.*, co.total AS order_total, c.name AS client_name, co.delivery_address
      FROM deliveries d
      JOIN customer_orders co ON d.order_id=co.id
      LEFT JOIN clients c ON co.client_id=c.id
      WHERE d.deliveryman_id=$${p.length+1} AND ${sql}
      ORDER BY d.created_at DESC LIMIT 50
    `, [...p, req.params.id]);
    res.json(rows);
  } catch (err) {
    console.error('GET /deliverymen/:id/livraisons:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = { deliveries: router, deliverymen: router2 };
