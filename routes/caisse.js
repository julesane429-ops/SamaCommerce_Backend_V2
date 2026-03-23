const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');
const requirePlan = require('../middleware/checkSubscription');
const bf          = require('../middleware/boutiqueFilter');

// GET /caisse/today
router.get('/today', verifyToken, perm('caisse'), requirePlan('caisse'), async (req, res) => {
  try {
    const { sql, p } = bf(req);

    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                                               AS nb_ventes,
        COALESCE(SUM(total) FILTER (WHERE payment_method='especes' AND paid=true),0) AS especes,
        COALESCE(SUM(total) FILTER (WHERE payment_method='wave'    AND paid=true),0) AS wave,
        COALESCE(SUM(total) FILTER (WHERE payment_method='orange'  AND paid=true),0) AS orange,
        COALESCE(SUM(total) FILTER (WHERE payment_method='credit'  AND paid=false),0) AS credits,
        COALESCE(SUM(total) FILTER (WHERE paid=true),0)                              AS total_encaisse,
        COALESCE(SUM(total),0)                                                       AS total_ca
      FROM sales
      WHERE ${sql} AND DATE(created_at) = CURRENT_DATE
    `, p);

    const { rows: retRows } = await db.query(`
      SELECT COALESCE(SUM(refund_amount),0) AS total_retours, COUNT(*)::int AS nb_retours
      FROM returns
      WHERE ${sql} AND DATE(created_at) = CURRENT_DATE
    `, p);

    const data = rows[0];
    data.total_retours = retRows[0].total_retours;
    data.nb_retours    = retRows[0].nb_retours;
    data.net           = data.total_encaisse - data.total_retours;
    res.json(data);
  } catch (err) {
    console.error('GET /caisse/today:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /caisse/close
router.post('/close', verifyToken, perm('caisse'), requirePlan('caisse'), async (req, res) => {
  try {
    const { sql, p, bid, uid } = bf(req);

    const { rows: data } = await db.query(`
      SELECT
        COALESCE(SUM(total) FILTER (WHERE payment_method='especes' AND paid=true),0) AS especes,
        COALESCE(SUM(total) FILTER (WHERE payment_method='wave'    AND paid=true),0) AS wave,
        COALESCE(SUM(total) FILTER (WHERE payment_method='orange'  AND paid=true),0) AS orange,
        COALESCE(SUM(total) FILTER (WHERE payment_method='credit'  AND paid=false),0) AS credits,
        COALESCE(SUM(total) FILTER (WHERE paid=true),0) AS total_encaisse,
        COUNT(*)::int AS nb_ventes
      FROM sales WHERE ${sql} AND DATE(created_at) = CURRENT_DATE
    `, p);

    const { rows: ret } = await db.query(
      `SELECT COALESCE(SUM(refund_amount),0) AS total FROM returns WHERE ${sql} AND DATE(created_at) = CURRENT_DATE`,
      p
    );

    const d   = data[0];
    const net = d.total_encaisse - ret[0].total;

    // ON CONFLICT nécessite (boutique_id, date) OU (user_id, date)
    const { rows } = await db.query(`
      INSERT INTO caisse_closings
        (user_id, boutique_id, total_especes, total_wave, total_orange,
         total_credits, total_retours, total_net, nb_ventes, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (user_id, date) DO UPDATE SET
        boutique_id=$2, total_especes=$3, total_wave=$4, total_orange=$5,
        total_credits=$6, total_retours=$7, total_net=$8, nb_ventes=$9, notes=$10
      RETURNING *
    `, [uid, bid || null, d.especes, d.wave, d.orange, d.credits, ret[0].total, net, d.nb_ventes, req.body.notes || null]);

    res.json(rows[0]);
  } catch (err) {
    console.error('POST /caisse/close:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /caisse/history
router.get('/history', verifyToken, perm('caisse'), requirePlan('caisse'), async (req, res) => {
  try {
    const { sql, p } = bf(req);
    const { rows } = await db.query(
      `SELECT * FROM caisse_closings WHERE ${sql} ORDER BY date DESC LIMIT 30`,
      p
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /caisse/history:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /caisse/weekly
router.get('/weekly', verifyToken, perm('caisse'), requirePlan('caisse'), async (req, res) => {
  try {
    const { sql, p } = bf(req);
    const { rows } = await db.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'UTC')                                   AS date,
        COUNT(*) FILTER (WHERE paid=true)::int                                AS nb_ventes,
        COALESCE(SUM(total) FILTER (WHERE paid=true), 0)::numeric             AS total_encaisse,
        COALESCE(SUM(total) FILTER (WHERE payment_method='especes' AND paid=true), 0) AS especes,
        COALESCE(SUM(total) FILTER (WHERE payment_method='wave'    AND paid=true), 0) AS wave,
        COALESCE(SUM(total) FILTER (WHERE payment_method='orange'  AND paid=true), 0) AS orange,
        COALESCE(SUM(total) FILTER (WHERE paid=false), 0)                     AS credits
      FROM sales
      WHERE ${sql} AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at AT TIME ZONE 'UTC')
      ORDER BY date ASC
    `, p);

    const result = [];
    for (let i = 6; i >= 0; i--) {
      const d  = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
      const ds = d.toISOString().split('T')[0];
      const ex = rows.find(r => {
        const rd = r.date instanceof Date ? r.date.toISOString().split('T')[0] : r.date;
        return rd === ds;
      });
      result.push(ex || {
        date: ds, nb_ventes: 0, total_encaisse: 0,
        especes: 0, wave: 0, orange: 0, credits: 0,
      });
    }
    res.json(result);
  } catch (err) {
    console.error('GET /caisse/weekly:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
