const express = require('express');
const router  = express.Router();
const db      = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

// ── Helper scope boutique / user ──────────────────────────────────
function saleScope(req) {
  if (req.user.boutique_id) {
    // Multi-boutique : filtre par boutique_id précis
    return {
      clause: '(s.boutique_id = $1 OR (s.boutique_id IS NULL AND s.user_id = $2))',
      params: [req.user.boutique_id, req.user.id],
    };
  }
  // Legacy mono-boutique
  return {
    clause: '(s.boutique_id IS NULL AND s.user_id = $1) OR s.boutique_id IN (SELECT id FROM boutiques WHERE owner_id = $1)',
    params: [req.user.id],
  };
}

// ── GET /sales ─────────────────────────────────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit || '200')));
    const offset = (page - 1) * limit;

    const days         = parseInt(req.query.days || '0');
    const dateClause   = days > 0 ? `AND s.created_at >= NOW() - INTERVAL '${days} days'` : '';
    const cursor       = parseInt(req.query.cursor || '0');
    const cursorClause = cursor > 0 ? `AND s.id < ${cursor}` : '';

    const { clause, params } = saleScope(req);
    const pLen = params.length;

    const result = await db.query(`
      SELECT s.*, p.name AS product_name
      FROM sales s
      LEFT JOIN products p ON s.product_id = p.id
      WHERE ${clause}
        ${dateClause}
        ${cursorClause}
      ORDER BY s.created_at DESC
      LIMIT $${pLen + 1} OFFSET $${pLen + 2}
    `, [...params, limit, offset]);

    res.json(result.rows);
  } catch (err) {
    console.error('Erreur GET /sales :', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /sales ── Nouvelle vente ─────────────────────────────────
// ✅ Correction : lookup produit par boutique_id (pas seulement user_id)
router.post('/', verifyToken, perm('vente'), async (req, res) => {
  const {
    product_id, quantity, nb_lots, payment_method,
    client_name, client_phone, client_id, due_date,
    sale_type    = 'detail',
    prix_negocie = null
  } = req.body;

  if (!['detail', 'gros'].includes(sale_type)) {
    return res.status(400).json({ error: "sale_type invalide. Valeurs : detail | gros" });
  }

  try {
    // ✅ Chercher le produit avec le bon scope boutique
    const { clause, params } = saleScope(req);
    // Adapter la clause pour products (alias p au lieu de s)
    const prodClause = clause.replace(/s\./g, 'p.').replace(/s\.user_id/g, 'p.user_id');

    // Requête simplifiée : chercher par id + user_id (le produit appartient à l'owner)
    const prodResult = await db.query(
      `SELECT price, price_achat, stock, price_gros, quantite_gros
       FROM products
       WHERE id = $1
         AND (
           (boutique_id = $2 AND boutique_id IS NOT NULL)
           OR (boutique_id IS NULL AND user_id = $3)
           OR user_id = $3
         )
         AND deleted_at IS NULL`,
      [product_id, req.user.boutique_id || -1, req.user.id]
    );

    if (!prodResult.rows.length) return res.status(404).json({ error: 'Produit introuvable' });
    const product = prodResult.rows[0];

    // ── Calculs gros / détail ──
    let qteVendue, prixReference, prixUnitaire, total, nbLots = null;

    if (sale_type === 'gros') {
      if (!product.price_gros || !product.quantite_gros) {
        return res.status(400).json({ error: 'Ce produit n\'est pas configuré pour la vente en gros.' });
      }
      if (!nb_lots || isNaN(+nb_lots) || +nb_lots < 1) {
        return res.status(400).json({ error: 'nb_lots requis et doit être ≥ 1.' });
      }
      nbLots        = parseInt(nb_lots);
      qteVendue     = nbLots * product.quantite_gros;
      prixReference = parseFloat(product.price_gros);
      prixUnitaire  = prix_negocie != null ? parseFloat(prix_negocie) : prixReference;
      total         = prixUnitaire * nbLots;
    } else {
      if (!quantity || isNaN(+quantity) || +quantity < 1) {
        return res.status(400).json({ error: 'quantity requis et doit être ≥ 1.' });
      }
      qteVendue     = parseInt(quantity);
      prixReference = parseFloat(product.price);
      prixUnitaire  = prix_negocie != null ? parseFloat(prix_negocie) : prixReference;
      total         = prixUnitaire * qteVendue;
    }

    if (product.stock < qteVendue) {
      return res.status(400).json({
        error: `Stock insuffisant. Disponible : ${product.stock}, demandé : ${qteVendue}.`
      });
    }

    // Garde-fou anti-perte (80% du prix d'achat)
    if (prix_negocie != null) {
      const seuilMin = parseFloat(product.price_achat) * 0.8;
      if (prixUnitaire < seuilMin) {
        return res.status(400).json({
          error: `Prix négocié trop bas. Minimum conseillé : ${Math.round(seuilMin)} F (80% du prix d'achat).`,
          prix_achat: parseFloat(product.price_achat)
        });
      }
    }

    const paid       = payment_method === 'credit' ? false : true;
    const boutiqueId = req.user.boutique_id || null;

    const saleResult = await db.query(
      `INSERT INTO sales
        (product_id, quantity, total, payment_method, user_id, boutique_id,
         client_name, client_phone, client_id, due_date, paid,
         sale_type, nb_lots, prix_negocie, prix_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        product_id, qteVendue, total, payment_method,
        req.user.id, boutiqueId,
        client_name  || null, client_phone || null, client_id || null,
        due_date     || null, paid,
        sale_type, nbLots,
        prix_negocie != null ? parseFloat(prix_negocie) : null,
        prixReference
      ]
    );

    // Décrémenter le stock
    await db.query(
      'UPDATE products SET stock = stock - $1 WHERE id = $2',
      [qteVendue, product_id]
    );

    res.status(201).json(saleResult.rows[0]);
  } catch (err) {
    console.error("Erreur POST /sales :", err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /sales/:id ─────────────────────────────────────────────
router.patch('/:id', verifyToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { quantity, payment_method, paid, repayment_method } = req.body;

  try {
    const venteResult = await db.query(
      'SELECT * FROM sales WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (!venteResult.rowCount) return res.status(404).json({ error: 'Vente introuvable ou non autorisée' });
    const vente = venteResult.rows[0];

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
         SET quantity=$1, total=$2,
             payment_method=COALESCE($3,payment_method),
             paid=COALESCE($4,paid),
             repayment_method=COALESCE($5,repayment_method)
         WHERE id=$6 AND user_id=$7`,
        [quantity, product.price * quantity, payment_method, paid, repayment_method, id, req.user.id]
      );
      await db.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2',
        [diff, vente.product_id]
      );
    } else {
      await db.query(
        `UPDATE sales
         SET payment_method=COALESCE($1,payment_method),
             paid=COALESCE($2,paid),
             repayment_method=COALESCE($3,repayment_method)
         WHERE id=$4 AND user_id=$5`,
        [payment_method, paid, repayment_method, id, req.user.id]
      );
    }

    const updated = await db.query('SELECT * FROM sales WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error("Erreur PATCH /sales/:id :", err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /sales/:id ── Annuler + recréditer stock ───────────────
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM sales WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vente introuvable' });

    const vente = rows[0];
    await db.query('DELETE FROM sales WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);

    if (vente.product_id && vente.quantity) {
      await db.query(
        'UPDATE products SET stock = stock + $1 WHERE id = $2',
        [vente.quantity, vente.product_id]
      );
    }

    res.json({ message: 'Vente annulée', restored_qty: vente.quantity });
  } catch (err) {
    console.error('Erreur DELETE /sales/:id :', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /sales/:id/partial-payment ─────────────────────────────
router.patch('/:id/partial-payment', verifyToken, async (req, res) => {
  const { amount, payment_method } = req.body;
  if (!amount || isNaN(+amount) || +amount <= 0) {
    return res.status(400).json({ error: 'Montant invalide' });
  }

  try {
    const { rows } = await db.query(
      'SELECT * FROM sales WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vente introuvable' });

    const vente = rows[0];
    if (vente.paid)                              return res.status(400).json({ error: 'Crédit déjà entièrement remboursé' });
    if (vente.payment_method !== 'credit')       return res.status(400).json({ error: "Cette vente n'est pas un crédit" });

    const alreadyPaid = parseFloat(vente.amount_paid) || 0;
    const newPaid     = parseFloat((alreadyPaid + parseFloat(amount)).toFixed(2));
    const total       = parseFloat(vente.total) || 0;
    const remaining   = parseFloat((total - newPaid).toFixed(2));

    if (newPaid > total) {
      return res.status(400).json({
        error: `Montant trop élevé. Restant dû : ${(total - alreadyPaid).toLocaleString('fr-FR')} F`
      });
    }

    const isFullyPaid = remaining <= 0;
    const { rows: updated } = await db.query(
      `UPDATE sales SET amount_paid=$1, paid=$2, repayment_method=COALESCE($3,repayment_method)
       WHERE id=$4 AND user_id=$5 RETURNING *`,
      [newPaid, isFullyPaid, payment_method || null, req.params.id, req.user.id]
    );

    res.json({
      sale:        updated[0],
      amount_paid: newPaid,
      remaining:   Math.max(0, remaining),
      fully_paid:  isFullyPaid,
      message:     isFullyPaid
        ? '✅ Crédit entièrement remboursé'
        : `💳 Paiement partiel — Reste : ${Math.max(0, remaining).toLocaleString('fr-FR')} F`,
    });
  } catch (err) {
    console.error('PATCH /sales/:id/partial-payment:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
