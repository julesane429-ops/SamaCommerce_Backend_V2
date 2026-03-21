// routes/deliveries.js — Livraisons vers clients
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const verifyToken = require('../middleware/auth');

// ── GET / ── Liste des livraisons
router.get('/', verifyToken, async (req, res) => {
  try {
    const { status } = req.query;
    const where  = status && status !== 'tous' ? 'AND d.status = $2' : '';
    const params = status && status !== 'tous' ? [req.user.id, status] : [req.user.id];

    const { rows } = await db.query(`
      SELECT
        d.*,
        co.delivery_address,
        co.delivery_date,
        co.total            AS order_total,
        co.payment_status,
        c.name              AS client_name,
        c.phone             AS client_phone,
        dm.name             AS deliveryman_name,
        dm.phone            AS deliveryman_phone,
        dm.status           AS deliveryman_status
      FROM deliveries d
      JOIN customer_orders co ON d.order_id = co.id
      LEFT JOIN clients     c  ON co.client_id       = c.id
      LEFT JOIN deliverymen dm ON d.deliveryman_id   = dm.id
      WHERE d.user_id = $1 ${where}
      ORDER BY d.created_at DESC
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('GET /deliveries:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /:id ── Détail livraison
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        d.*,
        co.delivery_address, co.delivery_date, co.total AS order_total,
        co.payment_status, co.payment_method, co.notes AS order_notes,
        c.name AS client_name, c.phone AS client_phone, c.address AS client_address,
        dm.name AS deliveryman_name, dm.phone AS deliveryman_phone, dm.zone AS deliveryman_zone
      FROM deliveries d
      JOIN customer_orders co ON d.order_id = co.id
      LEFT JOIN clients     c  ON co.client_id      = c.id
      LEFT JOIN deliverymen dm ON d.deliveryman_id  = dm.id
      WHERE d.id = $1 AND d.user_id = $2
    `, [req.params.id, req.user.id]);

    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });

    // Articles de la commande
    const { rows: items } = await db.query(`
      SELECT coi.*, p.name AS product_name, p.image_url
      FROM customer_order_items coi
      JOIN products p ON coi.product_id = p.id
      WHERE coi.order_id = $1
    `, [rows[0].order_id]);

    res.json({ ...rows[0], items });
  } catch (err) {
    console.error('GET /deliveries/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /:id/assign ── Assigner un livreur
router.patch('/:id/assign', verifyToken, async (req, res) => {
  const { deliveryman_id } = req.body;
  if (!deliveryman_id) return res.status(400).json({ error: 'deliveryman_id requis' });

  try {
    const { rows } = await db.query(`
      UPDATE deliveries SET deliveryman_id=$1, status='assignee'
      WHERE id=$2 AND user_id=$3 RETURNING *
    `, [deliveryman_id, req.params.id, req.user.id]);

    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });

    // Passer le livreur en_course
    await db.query(
      "UPDATE deliverymen SET status='en_course' WHERE id=$1",
      [deliveryman_id]
    );

    // Mettre à jour la commande
    await db.query(
      "UPDATE customer_orders SET status='en_livraison' WHERE id=$1",
      [rows[0].order_id]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /deliveries/:id/assign:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /:id/depart ── Livreur part
router.patch('/:id/depart', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      UPDATE deliveries SET status='en_route', pickup_time=NOW()
      WHERE id=$1 AND user_id=$2 RETURNING *
    `, [req.params.id, req.user.id]);

    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /deliveries/:id/depart:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /:id/livree ── Marquer comme livrée → débiter stock + enregistrer vente si besoin
router.patch('/:id/livree', verifyToken, async (req, res) => {
  const dbClient = await db.connect();
  try {
    await dbClient.query('BEGIN');

    // Récupérer la livraison + commande
    const { rows: del } = await dbClient.query(
      'SELECT d.*, co.client_id, co.payment_status, co.payment_method, co.total FROM deliveries d JOIN customer_orders co ON d.order_id = co.id WHERE d.id=$1 AND d.user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!del.length) { await dbClient.query('ROLLBACK'); return res.status(404).json({ error: 'Livraison introuvable' }); }
    const delivery = del[0];

    // Récupérer les articles
    const { rows: items } = await dbClient.query(
      'SELECT * FROM customer_order_items WHERE order_id = $1',
      [delivery.order_id]
    );

    // Débiter le stock (stock ET stock_reserved)
    for (const it of items) {
      await dbClient.query(
        'UPDATE products SET stock = stock - $1, stock_reserved = GREATEST(0, stock_reserved - $1) WHERE id = $2',
        [it.quantity, it.product_id]
      );
    }

    // Si paiement "à encaisser" → enregistrer la vente dans sales
    if (delivery.payment_status === 'a_encaisser') {
      for (const it of items) {
        await dbClient.query(`
          INSERT INTO sales (product_id, quantity, total, payment_method, user_id, client_id, paid)
          VALUES ($1,$2,$3,$4,$5,$6,true)
        `, [it.product_id, it.quantity, it.prix_unitaire * it.quantity,
            delivery.payment_method || 'especes', req.user.id, delivery.client_id]);
      }
    }

    // Mettre à jour les statuts
    await dbClient.query(
      "UPDATE deliveries SET status='livree', delivered_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    await dbClient.query(
      "UPDATE customer_orders SET status='livree', delivered_at=NOW(), payment_status='paye' WHERE id=$1",
      [delivery.order_id]
    );

    // Libérer le livreur
    if (delivery.deliveryman_id) {
      await dbClient.query(
        "UPDATE deliverymen SET status='disponible' WHERE id=$1",
        [delivery.deliveryman_id]
      );
    }

    await dbClient.query('COMMIT');
    res.json({ message: 'Livraison confirmée — stock débité', delivery_id: req.params.id });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('PATCH /deliveries/:id/livree:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    dbClient.release();
  }
});

// ── PATCH /:id ── Mise à jour générale (note, statut problème)
router.patch('/:id', verifyToken, async (req, res) => {
  const { tracking_note, status } = req.body;
  const fields = [], values = [];
  let i = 1;
  if (tracking_note !== undefined) { fields.push(`tracking_note=$${i++}`); values.push(tracking_note); }
  if (status !== undefined)        { fields.push(`status=$${i++}`);        values.push(status); }
  if (!fields.length) return res.status(400).json({ error: 'Rien à mettre à jour' });

  try {
    values.push(req.params.id, req.user.id);
    const { rows } = await db.query(
      `UPDATE deliveries SET ${fields.join(',')} WHERE id=$${i} AND user_id=$${i+1} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Livraison introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /deliveries/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;


// ════════════════════════════════════════════════════════════
// routes/deliverymen.js — Livreurs
// ════════════════════════════════════════════════════════════
const express2     = require('express');
const router2      = express2.Router();

// ── GET / ──
router2.get('/', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT dm.*,
        COUNT(d.id)::int                                         AS nb_livraisons,
        COUNT(d.id) FILTER (WHERE d.status='livree')::int        AS nb_livrees,
        COUNT(d.id) FILTER (WHERE d.status='en_route')::int      AS en_cours
      FROM deliverymen dm
      LEFT JOIN deliveries d ON d.deliveryman_id = dm.id
      WHERE dm.user_id = $1
      GROUP BY dm.id
      ORDER BY dm.name
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('GET /deliverymen:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST / ── Ajouter un livreur
router2.post('/', verifyToken, async (req, res) => {
  const { name, phone, zone, tarif_livraison, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  try {
    const { rows } = await db.query(
      'INSERT INTO deliverymen (user_id, name, phone, zone, tarif_livraison, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, name, phone||null, zone||null, tarif_livraison||0, notes||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /deliverymen:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /:id ── Modifier
router2.patch('/:id', verifyToken, async (req, res) => {
  const allowed = ['name','phone','zone','tarif_livraison','status','notes'];
  const fields = [], values = [];
  let i = 1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key}=$${i++}`); values.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Rien à mettre à jour' });
  try {
    values.push(req.params.id, req.user.id);
    const { rows } = await db.query(
      `UPDATE deliverymen SET ${fields.join(',')} WHERE id=$${i} AND user_id=$${i+1} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Livreur introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /deliverymen/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /:id ──
router2.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM deliverymen WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Livreur introuvable' });
    res.json({ message: 'Livreur supprimé' });
  } catch (err) {
    console.error('DELETE /deliverymen:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /:id/livraisons ── Historique du livreur
router2.get('/:id/livraisons', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT d.*, co.total AS order_total, c.name AS client_name, co.delivery_address
      FROM deliveries d
      JOIN customer_orders co ON d.order_id = co.id
      LEFT JOIN clients c ON co.client_id = c.id
      WHERE d.deliveryman_id = $1 AND d.user_id = $2
      ORDER BY d.created_at DESC
      LIMIT 50
    `, [req.params.id, req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('GET /deliverymen/:id/livraisons:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = { deliveries: router, deliverymen: router2 };
