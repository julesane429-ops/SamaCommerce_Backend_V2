const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');

// ── GET /sales ─────────────────────────────────────────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = req.query.limit ? Math.min(500, Math.max(1, parseInt(req.query.limit))) : 0;
    const offset = limit > 0 ? (page - 1) * limit : 0;

    let queryText = `
      SELECT s.*, p.name AS product_name
      FROM sales s
      LEFT JOIN products p ON s.product_id = p.id
      WHERE s.user_id = $1
      ORDER BY s.created_at DESC
    `;
    const queryParams = [req.user.id];

    if (limit > 0) {
      queryText += ` LIMIT $2 OFFSET $3`;
      queryParams.push(limit, offset);
    }

    const result = await db.query(queryText, queryParams);
    res.json(result.rows);
  } catch (err) {
    console.error("Erreur GET /sales :", err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /sales ────────────────────────────────────────────────────────────
// Gère 3 cas :
//   1. Vente en détail (sale_type = 'detail') — comportement classique
//   2. Vente en gros   (sale_type = 'gros')   — par lots, stock en conséquence
//   3. Marchandage     (prix_negocie fourni)   — prix libre avec garde-fou anti-perte
router.post('/', verifyToken, async (req, res) => {
  const {
    product_id,
    quantity,         // utilisé pour le détail
    nb_lots,          // utilisé pour le gros
    payment_method,
    client_name,
    client_phone,
    client_id,
    due_date,
    sale_type    = 'detail',
    prix_negocie = null
  } = req.body;

  // Validation sale_type
  if (!['detail', 'gros'].includes(sale_type)) {
    return res.status(400).json({ error: "sale_type invalide. Valeurs : detail | gros" });
  }

  try {
    // 1. Récupérer le produit
    const prodResult = await db.query(
      `SELECT price, price_achat, stock, price_gros, quantite_gros
       FROM products
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [product_id, req.user.id]
    );
    if (!prodResult.rows.length) {
      return res.status(404).json({ error: 'Produit introuvable' });
    }
    const product = prodResult.rows[0];

    // ── Calculs selon le mode ──────────────────────────────────────────────
    let qteVendue;       // unités déduites du stock
    let prixReference;   // prix catalogue (pour les rapports)
    let prixUnitaire;    // prix effectivement appliqué (après négo éventuelle)
    let total;
    let nbLots = null;

    if (sale_type === 'gros') {
      // Vérifications spécifiques gros
      if (!product.price_gros || !product.quantite_gros) {
        return res.status(400).json({
          error: 'Ce produit n\'est pas configuré pour la vente en gros. Renseignez price_gros et quantite_gros.'
        });
      }
      if (!nb_lots || isNaN(+nb_lots) || +nb_lots < 1) {
        return res.status(400).json({ error: 'nb_lots requis et doit être ≥ 1 pour une vente en gros.' });
      }

      nbLots    = parseInt(nb_lots);
      qteVendue = nbLots * product.quantite_gros;  // ex: 3 sacs × 50 kg = 150 unités
      prixReference = parseFloat(product.price_gros);
      prixUnitaire  = prix_negocie != null ? parseFloat(prix_negocie) : prixReference;
      total         = prixUnitaire * nbLots;        // prix par lot × nb lots

    } else {
      // Vente en détail
      if (!quantity || isNaN(+quantity) || +quantity < 1) {
        return res.status(400).json({ error: 'quantity requis et doit être ≥ 1 pour une vente en détail.' });
      }

      qteVendue     = parseInt(quantity);
      prixReference = parseFloat(product.price);
      prixUnitaire  = prix_negocie != null ? parseFloat(prix_negocie) : prixReference;
      total         = prixUnitaire * qteVendue;
    }

    // 2. Vérifier le stock
    if (product.stock < qteVendue) {
      return res.status(400).json({
        error: `Stock insuffisant. Disponible : ${product.stock} unité(s), demandé : ${qteVendue}.`
      });
    }

    // 3. Garde-fou anti-perte : alerter si prix négocié < prix d'achat
    //    On bloque si la perte est flagrante (prix négo < 80% du prix achat)
    if (prix_negocie != null) {
      const prixAchatUnitaire = parseFloat(product.price_achat);
      if (prixUnitaire < prixAchatUnitaire * 0.8) {
        return res.status(400).json({
          error: `Prix négocié trop bas. Prix d'achat unitaire : ${prixAchatUnitaire} F. Vendre en dessous de ${Math.round(prixAchatUnitaire * 0.8)} F entraînerait une perte importante.`,
          prix_achat: prixAchatUnitaire
        });
      }
    }

    // 4. Insérer la vente
    const paid = (payment_method === 'credit') ? false : true;

    const insertResult = await db.query(
      `INSERT INTO sales
        (product_id, quantity, total, payment_method, user_id,
         client_name, client_phone, client_id, due_date, paid,
         sale_type, nb_lots, prix_negocie, prix_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        product_id,
        qteVendue,
        total,
        payment_method,
        req.user.id,
        client_name  || null,
        client_phone || null,
        client_id    || null,
        due_date     || null,
        paid,
        sale_type,
        nbLots,
        prix_negocie != null ? parseFloat(prix_negocie) : null,
        prixReference
      ]
    );
    const newSale = insertResult.rows[0];

    // 5. Décrémenter le stock
    await db.query(
      'UPDATE products SET stock = stock - $1 WHERE id = $2 AND user_id = $3',
      [qteVendue, product_id, req.user.id]
    );

    res.status(201).json(newSale);
  } catch (err) {
    console.error("Erreur POST /sales :", err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /sales/:id ───────────────────────────────────────────────────────
// Modification d'une vente existante (paiement, remboursement)
// Note : on ne permet pas de changer sale_type après coup (trop risqué pour le stock)
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

    if (quantity && quantity !== vente.quantity) {
      const productResult = await db.query(
        'SELECT price, price_gros, stock FROM products WHERE id = $1 AND user_id = $2',
        [vente.product_id, req.user.id]
      );
      const product = productResult.rows[0];
      if (!product) return res.status(404).json({ error: 'Produit introuvable' });

      const diff = quantity - vente.quantity;
      if (product.stock < diff) return res.status(400).json({ error: 'Stock insuffisant' });

      // Recalculer le total avec le prix de référence original
      const prixRef = parseFloat(vente.prix_reference) || parseFloat(product.price);
      const newTotal = vente.sale_type === 'gros'
        ? prixRef * (vente.nb_lots || 1)
        : prixRef * quantity;

      await db.query(
        `UPDATE sales
         SET quantity         = $1,
             total            = $2,
             payment_method   = COALESCE($3, payment_method),
             paid             = COALESCE($4, paid),
             repayment_method = COALESCE($5, repayment_method)
         WHERE id = $6 AND user_id = $7`,
        [quantity, newTotal, payment_method, paid, repayment_method, id, req.user.id]
      );
      await db.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2 AND user_id = $3',
        [diff, vente.product_id, req.user.id]
      );
    } else {
      await db.query(
        `UPDATE sales
         SET payment_method   = COALESCE($1, payment_method),
             paid             = COALESCE($2, paid),
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
    console.error("Erreur PATCH /sales/:id :", err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /sales/:id ──────────────────────────────────────────────────────
// Annulation d'une vente + restauration du stock
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM sales WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Vente introuvable' });

    // Restaurer le stock (quantité réelle débitée, peu importe détail ou gros)
    const cancelledSale = result.rows[0];
    if (cancelledSale.product_id && cancelledSale.quantity) {
      await db.query(
        'UPDATE products SET stock = stock + $1 WHERE id = $2',
        [cancelledSale.quantity, cancelledSale.product_id]
      );
    }

    res.json({ message: 'Vente annulée', sale: cancelledSale });
  } catch (err) {
    console.error("Erreur DELETE /sales/:id :", err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /sales/:id/partial-payment ──────────────────────────────────────
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
    if (vente.paid)                        return res.status(400).json({ error: 'Crédit déjà entièrement remboursé' });
    if (vente.payment_method !== 'credit') return res.status(400).json({ error: "Cette vente n'est pas un crédit" });

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
      `UPDATE sales
       SET amount_paid      = $1,
           paid             = $2,
           repayment_method = COALESCE($3, repayment_method)
       WHERE id = $4 AND user_id = $5
       RETURNING *`,
      [newPaid, isFullyPaid, payment_method || null, req.params.id, req.user.id]
    );

    res.json({
      sale:        updated[0],
      amount_paid: newPaid,
      remaining:   Math.max(0, remaining),
      fully_paid:  isFullyPaid,
      message:     isFullyPaid
        ? '✅ Crédit entièrement remboursé'
        : `💳 Paiement partiel enregistré — Reste : ${Math.max(0, remaining).toLocaleString('fr-FR')} F`,
    });
  } catch (err) {
    console.error('PATCH /sales/:id/partial-payment:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
