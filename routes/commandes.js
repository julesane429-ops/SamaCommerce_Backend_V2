const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verify      = require('../middleware/auth');
const requirePlan = require('../middleware/checkSubscription');
const bf          = require('../middleware/boutiqueFilter');

router.get('/', verify, requirePlan('commandes'), async (req, res) => {
  try {
    const { sql, p } = bf(req, 'c');
    const { rows } = await db.query(`
      SELECT c.*, f.name AS fournisseur_name, f.phone AS fournisseur_phone,
             COUNT(ci.id)::int AS nb_items
      FROM restock_orders c
      LEFT JOIN fournisseurs   f  ON f.id = c.fournisseur_id
      LEFT JOIN commande_items ci ON ci.commande_id = c.id
      WHERE ${sql}
      GROUP BY c.id, f.name, f.phone ORDER BY c.created_at DESC
    `, p);
    res.json(rows);
  } catch (err) {
    console.error('GET /commandes:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/:id', verify, requirePlan('commandes'), async (req, res) => {
  try {
    const { sql, p } = bf(req, 'c');
    const { rows } = await db.query(`
      SELECT c.*, f.name AS fournisseur_name, f.phone AS fournisseur_phone
      FROM restock_orders c LEFT JOIN fournisseurs f ON f.id=c.fournisseur_id
      WHERE c.id=$${p.length+1} AND ${sql}
    `, [...p, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Commande introuvable' });

    const { rows: items } = await db.query(`
      SELECT ci.*, p.name AS product_name, p.stock AS product_stock
      FROM commande_items ci LEFT JOIN products p ON p.id=ci.product_id
      WHERE ci.commande_id=$1
    `, [req.params.id]);

    const { rows: livraisons } = await db.query(
      'SELECT * FROM restock_deliveries WHERE commande_id=$1 ORDER BY created_at DESC LIMIT 1',
      [req.params.id]
    );
    res.json({ ...rows[0], items, livraison: livraisons[0]||null });
  } catch (err) {
    console.error('GET /commandes/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', verify, requirePlan('commandes'), async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { fournisseur_id, notes, expected_date, items } = req.body;
    if (!items?.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Au moins un article requis' }); }

    const { bid, uid } = bf(req);
    const total = items.reduce((s, it) => s + (it.quantity * it.prix_unitaire), 0);
    const { rows: cmd } = await client.query(
      `INSERT INTO restock_orders (user_id, boutique_id, fournisseur_id, total, notes, expected_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,'en_attente') RETURNING *`,
      [uid, bid||null, fournisseur_id||null, total, notes||null, expected_date||null]
    );

    for (const it of items) {
      await client.query(
        'INSERT INTO commande_items (commande_id, product_id, quantity, prix_unitaire) VALUES ($1,$2,$3,$4)',
        [cmd[0].id, it.product_id, it.quantity, it.prix_unitaire]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(cmd[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /commandes:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

router.patch('/:id', verify, requirePlan('commandes'), async (req, res) => {
  try {
    const allowed = ['status','notes','expected_date','fournisseur_id'];
    const set = [], values = [];
    let i = 1;
    for (const f of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, f)) { set.push(`${f}=$${i++}`); values.push(req.body[f]); }
    }
    if (!set.length) return res.status(400).json({ error: 'Aucun champ' });
    const { uid } = bf(req);
    values.push(req.params.id, uid);
    const { rows } = await db.query(
      `UPDATE restock_orders SET ${set.join(',')}
       WHERE id=${i} AND user_id=${i+1} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Commande introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /commandes/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.patch('/:id/recevoir', verify, requirePlan('commandes'), async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { sql, p } = bf(req, 'c');
    const { rows: cmd } = await client.query(
      `SELECT * FROM restock_orders c WHERE c.id=$${p.length+1} AND ${sql}`, [...p, req.params.id]
    );
    if (!cmd.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Commande introuvable' }); }

    const { rows: items } = await client.query('SELECT * FROM commande_items WHERE commande_id=$1', [req.params.id]);
    for (const it of items) {
      await client.query('UPDATE products SET stock=stock+$1 WHERE id=$2 AND user_id=$3', [it.quantity, it.product_id, req.user.id]);
    }
    const { rows: updated } = await client.query(
      "UPDATE restock_orders SET status='recue' WHERE id=$1 RETURNING *", [req.params.id]
    );
    await client.query('COMMIT');
    res.json({ commande: updated[0], message: `Stock mis à jour pour ${items.length} produit(s)` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /commandes/:id/recevoir:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

router.delete('/:id', verify, requirePlan('commandes'), async (req, res) => {
  try {
    const { sql, p } = bf(req, 'c');
    const { rows } = await db.query(`DELETE FROM restock_orders c WHERE c.id=$${p.length+1} AND ${sql} RETURNING *`, [...p, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Commande introuvable' });
    res.json({ message: 'Commande supprimée' });
  } catch (err) {
    console.error('DELETE /commandes/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/:id/items', verify, requirePlan('commandes'), async (req, res) => {
  try {
    const { sql, p } = bf(req, 'c');
    const { rows: cmd } = await db.query(`SELECT id FROM restock_orders c WHERE c.id=$${p.length+1} AND ${sql}`, [...p, req.params.id]);
    if (!cmd.length) return res.status(404).json({ error: 'Commande introuvable' });

    const { product_id, quantity, prix_unitaire } = req.body;
    const { rows } = await db.query(
      'INSERT INTO commande_items (commande_id, product_id, quantity, prix_unitaire) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, product_id, quantity, prix_unitaire]
    );
    await db.query(
      'UPDATE restock_orders SET total=(SELECT COALESCE(SUM(quantity*prix_unitaire),0) FROM commande_items WHERE commande_id=$1) WHERE id=$1',
      [req.params.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/:id/items/:itemId', verify, requirePlan('commandes'), async (req, res) => {
  try {
    const { sql, p } = bf(req, 'c');
    const { rows: cmd } = await db.query(`SELECT id FROM restock_orders c WHERE c.id=$${p.length+1} AND ${sql}`, [...p, req.params.id]);
    if (!cmd.length) return res.status(404).json({ error: 'Commande introuvable' });
    await db.query('DELETE FROM commande_items WHERE id=$1 AND commande_id=$2', [req.params.itemId, req.params.id]);
    await db.query(
      'UPDATE restock_orders SET total=(SELECT COALESCE(SUM(quantity*prix_unitaire),0) FROM commande_items WHERE commande_id=$1) WHERE id=$1',
      [req.params.id]
    );
    res.json({ message: 'Ligne supprimée' });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;
