// ═══════════════════════════════════════════════════════════
// routes/caisse.js — Clôture de caisse quotidienne
// ═══════════════════════════════════════════════════════════
 
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');
const requirePlan = require('../middleware/checkSubscription');
 
// ── GET /caisse/today ── Données de caisse du jour
router.get('/today', verifyToken, perm('caisse'), requirePlan('caisse'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                                                      AS nb_ventes,
        COALESCE(SUM(total) FILTER (WHERE payment_method='especes' AND paid=true),0)      AS especes,
        COALESCE(SUM(total) FILTER (WHERE payment_method='wave'    AND paid=true),0)      AS wave,
        COALESCE(SUM(total) FILTER (WHERE payment_method='orange'  AND paid=true),0)      AS orange,
        COALESCE(SUM(total) FILTER (WHERE payment_method='credit'  AND paid=false),0)     AS credits,
        COALESCE(SUM(total) FILTER (WHERE paid=true),0)                                   AS total_encaisse,
        COALESCE(SUM(total),0)                                                             AS total_ca
      FROM sales
      WHERE (boutique_id = $1 OR (boutique_id IS NULL AND user_id = $1))
        AND DATE(created_at) = CURRENT_DATE
    `, [req.user.id]);
 
    // Retours du jour
    const { rows: retRows } = await db.query(`
      SELECT COALESCE(SUM(refund_amount),0) AS total_retours, COUNT(*)::int AS nb_retours
      FROM returns
      WHERE (boutique_id = $1 OR (boutique_id IS NULL AND user_id = $1)) AND DATE(created_at) = CURRENT_DATE
    `, [req.user.id]);
 
    const data = rows[0];
    data.total_retours = retRows[0].total_retours;
    data.nb_retours    = retRows[0].nb_retours;
    data.net           = data.total_encaisse - data.total_retours;
 
    res.json(data);
  } catch (err) {
    console.error('GET /caisse/today:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
 
// ── POST /caisse/close ── Enregistrer une clôture
router.post('/close', verifyToken, perm('caisse'), requirePlan('caisse'), async (req, res) => {
  try {
    const { rows: data } = await db.query(`
      SELECT
        COALESCE(SUM(total) FILTER (WHERE payment_method='especes' AND paid=true),0) AS especes,
        COALESCE(SUM(total) FILTER (WHERE payment_method='wave'    AND paid=true),0) AS wave,
        COALESCE(SUM(total) FILTER (WHERE payment_method='orange'  AND paid=true),0) AS orange,
        COALESCE(SUM(total) FILTER (WHERE payment_method='credit'  AND paid=false),0) AS credits,
        COALESCE(SUM(total) FILTER (WHERE paid=true),0) AS total_encaisse,
        COUNT(*)::int AS nb_ventes
      FROM sales
      WHERE (boutique_id = $1 OR (boutique_id IS NULL AND user_id = $1)) AND DATE(created_at) = CURRENT_DATE
    `, [req.user.id]);
 
    const { rows: ret } = await db.query(
      "SELECT COALESCE(SUM(refund_amount),0) AS total FROM returns WHERE (boutique_id = $1 OR (boutique_id IS NULL AND user_id = $1)) AND DATE(created_at) = CURRENT_DATE",
      [req.user.id]
    );
 
    const notes = req.body.notes || null;
    const d     = data[0];
    const net   = d.total_encaisse - ret[0].total;
 
    const result = await db.query(`
      INSERT INTO caisse_closings
        (user_id, boutique_id, total_especes, total_wave, total_orange, total_credits, total_retours, total_net, nb_ventes, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (user_id, date) DO UPDATE SET
        total_especes=$2, total_wave=$3, total_orange=$4, total_credits=$5,
        total_retours=$6, total_net=$7, nb_ventes=$8, notes=$9
      RETURNING *
    `, [req.user.id, req.user.boutique_id||null, d.especes, d.wave, d.orange, d.credits, ret[0].total, net, d.nb_ventes, notes]);
 
    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /caisse/close:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
 
// ── GET /caisse/history ── Historique des clôtures
router.get('/history', verifyToken, perm('caisse'), requirePlan('caisse'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM caisse_closings WHERE (boutique_id = $1 OR (boutique_id IS NULL AND user_id = $1)) ORDER BY date DESC LIMIT 30',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /caisse/history:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════
// PATCH routes/caisse.js — Ajouter avant module.exports
// Route historique hebdomadaire calculé depuis les ventes
// ═══════════════════════════════════════════════════════════

// ── GET /caisse/weekly ── 7 derniers jours depuis les ventes
router.get('/weekly', verifyToken, perm('caisse'), requirePlan('caisse'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'UTC')                              AS date,
        TO_CHAR(created_at AT TIME ZONE 'UTC', 'Dy DD')                 AS label,
        COUNT(*) FILTER (WHERE paid = true)::int                        AS nb_ventes,
        COALESCE(SUM(total) FILTER (WHERE paid = true), 0)::numeric     AS total_encaisse,
        COALESCE(SUM(total) FILTER (WHERE payment_method='especes' AND paid=true), 0) AS especes,
        COALESCE(SUM(total) FILTER (WHERE payment_method='wave'    AND paid=true), 0) AS wave,
        COALESCE(SUM(total) FILTER (WHERE payment_method='orange'  AND paid=true), 0) AS orange,
        COALESCE(SUM(total) FILTER (WHERE paid = false), 0)             AS credits
      FROM sales
      WHERE (boutique_id = $1 OR (boutique_id IS NULL AND user_id = $1))
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at AT TIME ZONE 'UTC')
      ORDER BY date ASC
    `, [req.user.id]);

    // Compléter les jours manquants avec des zéros
    const result = [];
    for (let i = 6; i >= 0; i--) {
      const d  = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
      const ds = d.toISOString().split('T')[0];
      const existing = rows.find(r => r.date?.toISOString?.()?.split('T')[0] === ds || r.date === ds);
      result.push(existing || {
        date:           ds,
        label:          d.toLocaleDateString('fr-FR', { weekday:'short', day:'2-digit' }),
        nb_ventes:      0,
        total_encaisse: 0,
        especes:        0,
        wave:           0,
        orange:         0,
        credits:        0,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('GET /caisse/weekly:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
module.exports = router;
