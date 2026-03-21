const express = require('express');
const router = express.Router();
const db = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

// ── GET /stats/ventes-par-categorie ───────────────────────────────────────
// Utilise s.total (prix réel encaissé) au lieu de quantity × price
router.get('/ventes-par-categorie', verifyToken, perm('rapports'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.name                AS categorie,
             SUM(s.quantity)       AS total_quantite,
             SUM(s.total)          AS total_montant
      FROM sales s
      JOIN products p   ON s.product_id = p.id
      JOIN categories c ON p.category_id = c.id
      WHERE s.user_id = $1
      GROUP BY c.name
      ORDER BY total_montant DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /stats/ventes-par-jour ─────────────────────────────────────────────
// Utilise s.total pour refléter les prix négociés et les ventes en gros
router.get('/ventes-par-jour', verifyToken, perm('rapports'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT DATE(s.created_at)    AS date,
             SUM(s.quantity)       AS total_quantite,
             SUM(s.total)          AS total_montant,
             COUNT(*)::int         AS nb_ventes
      FROM sales s
      WHERE s.user_id = $1
      GROUP BY DATE(s.created_at)
      ORDER BY date ASC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /stats/paiements ───────────────────────────────────────────────────
router.get('/paiements', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT s.payment_method,
             COUNT(*)::int   AS total_ventes,
             SUM(s.total)    AS total_montant
      FROM sales s
      WHERE s.user_id = $1
      GROUP BY s.payment_method
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /stats/top-produits ────────────────────────────────────────────────
router.get('/top-produits', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT p.name              AS produit,
             SUM(s.quantity)     AS total_quantite,
             SUM(s.total)        AS total_montant
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE s.user_id = $1
      GROUP BY p.name
      ORDER BY total_montant DESC
      LIMIT 10
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /stats/stock-faible ────────────────────────────────────────────────
router.get('/stock-faible', verifyToken, async (req, res) => {
  try {
    const seuil = parseInt(req.query.seuil) || 5;
    const { rows } = await db.query(`
      SELECT p.name  AS produit,
             p.stock,
             p.price,
             p.price_gros,
             p.quantite_gros
      FROM products p
      WHERE p.stock <= $1
        AND p.user_id = $2
        AND p.deleted_at IS NULL
      ORDER BY p.stock ASC
    `, [seuil, req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /stats/today ───────────────────────────────────────────────────────
router.get('/today', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                                          AS nb_ventes,
        COALESCE(SUM(s.total), 0)                                             AS ca_jour,
        COUNT(*)    FILTER (WHERE s.paid = true)::int                         AS nb_encaissees,
        COALESCE(SUM(s.total) FILTER (WHERE s.paid = true), 0)                AS ca_encaisse,
        COUNT(*)    FILTER (WHERE s.payment_method = 'credit' AND s.paid = false)::int AS nb_credits,
        -- Ventilation gros / détail
        COUNT(*)    FILTER (WHERE s.sale_type = 'gros')::int                  AS nb_ventes_gros,
        COUNT(*)    FILTER (WHERE s.sale_type = 'detail')::int                AS nb_ventes_detail,
        COALESCE(SUM(s.total) FILTER (WHERE s.sale_type = 'gros'),   0)       AS ca_gros,
        COALESCE(SUM(s.total) FILTER (WHERE s.sale_type = 'detail'), 0)       AS ca_detail,
        -- Marchandage du jour
        COUNT(*)    FILTER (WHERE s.prix_negocie IS NOT NULL)::int            AS nb_negocie,
        COALESCE(SUM(s.prix_reference - s.prix_negocie)
          FILTER (WHERE s.prix_negocie IS NOT NULL AND s.sale_type = 'detail'), 0) AS remises_detail,
        COALESCE(SUM(s.prix_reference - s.prix_negocie)
          FILTER (WHERE s.prix_negocie IS NOT NULL AND s.sale_type = 'gros'),  0) AS remises_gros
      FROM sales s
      WHERE s.user_id = $1
        AND DATE(s.created_at) = CURRENT_DATE
    `, [req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /stats/today:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /stats/gros-vs-detail ──────────────────────────────────────────────
// Rapport comparatif gros / détail sur une période
// Query params optionnels : ?debut=YYYY-MM-DD&fin=YYYY-MM-DD
router.get('/gros-vs-detail', verifyToken, perm('rapports'), async (req, res) => {
  try {
    const debut = req.query.debut || null;
    const fin   = req.query.fin   || null;

    let dateFilter = '';
    const params   = [req.user.id];
    let idx = 2;

    if (debut) { dateFilter += ` AND DATE(s.created_at) >= $${idx++}`; params.push(debut); }
    if (fin)   { dateFilter += ` AND DATE(s.created_at) <= $${idx++}`; params.push(fin); }

    const { rows } = await db.query(`
      SELECT
        s.sale_type,
        COUNT(*)::int          AS nb_ventes,
        SUM(s.quantity)        AS total_unites,
        SUM(s.total)           AS ca_total,
        AVG(s.total)           AS panier_moyen,
        -- Remises accordées (marchandage)
        COUNT(*) FILTER (WHERE s.prix_negocie IS NOT NULL)::int AS nb_avec_remise,
        COALESCE(
          SUM(
            CASE
              WHEN s.prix_negocie IS NOT NULL AND s.sale_type = 'detail'
                THEN (s.prix_reference - s.prix_negocie) * s.quantity
              WHEN s.prix_negocie IS NOT NULL AND s.sale_type = 'gros'
                THEN (s.prix_reference - s.prix_negocie) * COALESCE(s.nb_lots, 1)
              ELSE 0
            END
          ), 0
        ) AS total_remises
      FROM sales s
      WHERE s.user_id = $1
        ${dateFilter}
      GROUP BY s.sale_type
      ORDER BY s.sale_type
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('GET /stats/gros-vs-detail:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /stats/marchandage ─────────────────────────────────────────────────
// Détail des ventes avec négociation de prix
// Query params optionnels : ?debut=YYYY-MM-DD&fin=YYYY-MM-DD
router.get('/marchandage', verifyToken, perm('rapports'), async (req, res) => {
  try {
    const debut = req.query.debut || null;
    const fin   = req.query.fin   || null;

    let dateFilter = '';
    const params   = [req.user.id];
    let idx = 2;

    if (debut) { dateFilter += ` AND DATE(s.created_at) >= $${idx++}`; params.push(debut); }
    if (fin)   { dateFilter += ` AND DATE(s.created_at) <= $${idx++}`; params.push(fin); }

    const { rows } = await db.query(`
      SELECT
        DATE(s.created_at)      AS date,
        p.name                  AS produit,
        s.sale_type,
        s.quantity,
        s.nb_lots,
        s.prix_reference        AS prix_catalogue,
        s.prix_negocie,
        s.total                 AS total_encaisse,
        -- Remise unitaire accordée
        CASE
          WHEN s.sale_type = 'detail'
            THEN (s.prix_reference - s.prix_negocie) * s.quantity
          WHEN s.sale_type = 'gros'
            THEN (s.prix_reference - s.prix_negocie) * COALESCE(s.nb_lots, 1)
          ELSE 0
        END                     AS remise_totale,
        s.client_name,
        s.payment_method,
        s.created_at
      FROM sales s
      LEFT JOIN products p ON s.product_id = p.id
      WHERE s.user_id = $1
        AND s.prix_negocie IS NOT NULL
        ${dateFilter}
      ORDER BY s.created_at DESC
    `, params);

    // Totaux récapitulatifs
    const totaux = rows.reduce((acc, r) => ({
      nb_ventes:      acc.nb_ventes + 1,
      ca_encaisse:    acc.ca_encaisse    + parseFloat(r.total_encaisse   || 0),
      total_remises:  acc.total_remises  + parseFloat(r.remise_totale    || 0),
    }), { nb_ventes: 0, ca_encaisse: 0, total_remises: 0 });

    res.json({ ventes: rows, totaux });
  } catch (err) {
    console.error('GET /stats/marchandage:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
