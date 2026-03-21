// routes/commandes.js — Commandes de réapprovisionnement fournisseurs
// Table renommée : commandes → restock_orders
//                  commande_items → (inchangée)
//                  livraisons → restock_deliveries
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verify  = require('../middleware/auth');

// ─── GET /commandes ─── Liste des commandes fournisseurs
router.get('/', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*,
              f.name  AS fournisseur_name,
              f.phone AS fournisseur_phone,
              COUNT(ci.id)::int AS nb_items
       FROM restock_orders c
       LEFT JOIN fournisseurs  f  ON f.id = c.fournisseur_id
       LEFT JOIN commande_items ci ON ci.commande_id = c.id
       WHERE c.user_id = $1
       GROUP BY c.id, f.name, f.phone
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /commandes:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /commandes/:id ─── Détail commande + lignes + livraison liée
router.get('/:id', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, f.name AS fournisseur_name, f.phone AS fournisseur_phone
       FROM restock_orders c
       LEFT JOIN fournisseurs f ON f.id = c.fournisseur_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Commande introuvable' });

    const { rows: items } = await db.query(
      `SELECT ci.*, p.name AS product_name, p.stock AS product_stock
       FROM commande_items ci
       LEFT JOIN products p ON p.id = ci.product_id
       WHERE ci.commande_id = $1`,
      [req.params.id]
    );

    const { rows: livraisons } = await db.query(
      `SELECT * FROM restock_deliveries
       WHERE commande_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );

    res.json({ ...rows[0], items, livraison: livraisons[0] || null });
  } catch (err) {
    console.error('GET /commandes/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /commandes ─── Créer une commande avec ses lignes
router.post('/', verify, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { fournisseur_id, notes, expected_date, items } = req.body;
    if (!items?.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Au moins un article requis' });
    }

    const total = items.reduce((s, it) => s + (it.quantity * it.prix_unitaire), 0);

    const { rows: cmdRows } = await client.query(
      `INSERT INTO restock_orders
         (user_id, fournisseur_id, total, notes, expected_date, status)
       VALUES ($1,$2,$3,$4,$5,'en_attente') RETURNING *`,
      [req.user.id, fournisseur_id||null, total, notes||null, expected_date||null]
    );
    const commande = cmdRows[0];

    for (const it of items) {
      await client.query(
        `INSERT INTO commande_items (commande_id, product_id, quantity, prix_unitaire)
         VALUES ($1,$2,$3,$4)`,
        [commande.id, it.product_id, it.quantity, it.prix_unitaire]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(commande);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /commandes:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// ─── PATCH /commandes/:id ─── Modifier statut / notes
router.patch('/:id', verify, async (req, res) => {
  try {
    const allowed = ['status', 'notes', 'expected_date', 'fournisseur_id'];
    const set = [], values = [];
    let i = 1;
    for (const f of allowed) {
      if (req.body.hasOwnProperty(f)) { set.push(`${f} = $${i++}`); values.push(req.body[f]); }
    }
    if (!set.length) return res.status(400).json({ error: 'Aucun champ' });

    values.push(req.params.id, req.user.id);
    const { rows } = await db.query(
      `UPDATE restock_orders SET ${set.join(', ')}
       WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Commande introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /commandes/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PATCH /commandes/:id/recevoir ─── Marquer reçue + incrémenter le stock
router.patch('/:id/recevoir', verify, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: cmdRows } = await client.query(
      'SELECT * FROM restock_orders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!cmdRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Commande introuvable' });
    }

    const { rows: items } = await client.query(
      'SELECT * FROM commande_items WHERE commande_id = $1',
      [req.params.id]
    );

    for (const it of items) {
      await client.query(
        'UPDATE products SET stock = stock + $1 WHERE id = $2 AND user_id = $3',
        [it.quantity, it.product_id, req.user.id]
      );
    }

    const { rows: updated } = await client.query(
      `UPDATE restock_orders SET status = 'recue'
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );

    await client.query('COMMIT');
    res.json({ commande: updated[0], message: `Stock mis à jour pour ${items.length} produit(s)` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /commandes/:id/recevoir:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// ─── DELETE /commandes/:id ───
router.delete('/:id', verify, async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM restock_orders WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Commande introuvable' });
    res.json({ message: 'Commande supprimée' });
  } catch (err) {
    console.error('DELETE /commandes/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /commandes/:id/items ─── Ajouter une ligne
router.post('/:id/items', verify, async (req, res) => {
  try {
    const { rows: cmd } = await db.query(
      'SELECT id FROM restock_orders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!cmd.length) return res.status(404).json({ error: 'Commande introuvable' });

    const { product_id, quantity, prix_unitaire } = req.body;
    const { rows } = await db.query(
      `INSERT INTO commande_items (commande_id, product_id, quantity, prix_unitaire)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, product_id, quantity, prix_unitaire]
    );

    await db.query(
      `UPDATE restock_orders
       SET total = (SELECT COALESCE(SUM(quantity * prix_unitaire),0) FROM commande_items WHERE commande_id = $1)
       WHERE id = $1`,
      [req.params.id]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /commandes/:id/items:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── DELETE /commandes/:id/items/:itemId ─── Supprimer une ligne
router.delete('/:id/items/:itemId', verify, async (req, res) => {
  try {
    const { rows: cmd } = await db.query(
      'SELECT id FROM restock_orders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!cmd.length) return res.status(404).json({ error: 'Commande introuvable' });

    await db.query(
      'DELETE FROM commande_items WHERE id = $1 AND commande_id = $2',
      [req.params.itemId, req.params.id]
    );

    await db.query(
      `UPDATE restock_orders
       SET total = (SELECT COALESCE(SUM(quantity * prix_unitaire),0) FROM commande_items WHERE commande_id = $1)
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({ message: 'Ligne supprimée' });
  } catch (err) {
    console.error('DELETE /commandes/:id/items/:itemId:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
