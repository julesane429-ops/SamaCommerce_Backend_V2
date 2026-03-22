// routes/adminStats.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const verifyToken = require("../middleware/auth");

// Middleware local pour vérifier admin
function isAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Accès réservé aux administrateurs" });
  }
  next();
}

/**
 * GET /admin-stats/revenus?period=all|daily|weekly|monthly
 */
router.get("/revenus", verifyToken, isAdmin, async (req, res) => {
  try {
    const period = (req.query.period || "monthly").toLowerCase();

    let periodFilter = "";
    if (period === "daily") {
      periodFilter = "AND DATE(expiration) = CURRENT_DATE";
    } else if (period === "weekly") {
      periodFilter =
        "AND DATE_TRUNC('week', expiration) = DATE_TRUNC('week', CURRENT_DATE)";
    } else if (period === "monthly") {
      periodFilter =
        "AND DATE_TRUNC('month', expiration) = DATE_TRUNC('month', CURRENT_DATE)";
    }

    const balQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS balance
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'validé'`
    );

    const periodQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS period_total
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'validé' ${
         period === "all" ? "" : periodFilter
       }`
    );

    const pendingQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS pending
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'en attente'`
    );

    res.json({
      balance: Number(balQ.rows[0].balance || 0),
      periodTotal: Number(periodQ.rows[0].period_total || 0),
      pending: Number(pendingQ.rows[0].pending || 0),
      period,
    });
  } catch (err) {
    console.error("❌ Erreur /admin-stats/revenus:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /admin-stats/transactions?limit=10
 */
router.get("/transactions", verifyToken, isAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

    const q = await db.query(
      `SELECT id, username, plan, amount, payment_method, upgrade_status, expiration, created_at
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise')
       ORDER BY expiration DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );

    res.json(q.rows);
  } catch (err) {
    console.error("❌ Erreur /admin-stats/transactions:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /admin-stats/accounts
 */
router.get("/accounts", verifyToken, isAdmin, async (req, res) => {
  try {
    const payQ = await db.query(
      `SELECT payment_method, COALESCE(SUM(amount),0) AS total
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'validé'
       GROUP BY payment_method`
    );
    const accounts = { orange: 0, wave: 0, cash: 0 };
    payQ.rows.forEach(r => {
      if (r.payment_method) accounts[r.payment_method] = Number(r.total);
    });

    const wQ = await db.query(
      `SELECT method, COALESCE(SUM(amount),0) AS total
       FROM withdrawals
       WHERE admin_id = $1 AND status = 'validé'
       GROUP BY method`,
      [req.user.id]
    );
    wQ.rows.forEach(r => {
      if (r.method) accounts[r.method] -= Number(r.total);
    });

    const tQ = await db.query(
      `SELECT from_account, to_account, amount
       FROM admin_transfers
       WHERE admin_id = $1`,
      [req.user.id]
    );
    tQ.rows.forEach(r => {
      accounts[r.from_account] -= Number(r.amount);
      accounts[r.to_account]   += Number(r.amount);
    });

    const total = accounts.orange + accounts.wave + accounts.cash;

    const entriesQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise')
         AND upgrade_status = 'validé'
         AND DATE(created_at) = CURRENT_DATE`
    );
    const entries = Number(entriesQ.rows[0].total);

    const withdrawalsQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM withdrawals
       WHERE admin_id = $1
         AND status = 'validé'
         AND DATE(created_at) = CURRENT_DATE`,
      [req.user.id]
    );
    const withdrawals = Number(withdrawalsQ.rows[0].total);

    res.json({ accounts, total, entries, withdrawals, net: entries - withdrawals });
  } catch (err) {
    console.error("❌ Erreur /admin-stats/accounts:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /admin-stats/accounts/:method
 */
router.get("/accounts/:method", verifyToken, isAdmin, async (req, res) => {
  try {
    const { method } = req.params;

    const subs = await db.query(
      `SELECT username, amount, payment_method, expiration, created_at
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'validé' AND payment_method = $1
       ORDER BY expiration DESC NULLS LAST LIMIT 50`,
      [method]
    );

    const outs = await db.query(
      `SELECT amount, status, created_at
       FROM withdrawals
       WHERE admin_id = $1 AND status = 'validé' AND method = $2
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id, method]
    );

    const transfers = await db.query(
      `SELECT from_account, to_account, amount, created_at
       FROM admin_transfers
       WHERE admin_id = $1 AND (from_account = $2 OR to_account = $2)
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id, method]
    );

    res.json({
      subscriptions: subs.rows,
      withdrawals:   outs.rows,
      transfers:     transfers.rows,
    });
  } catch (err) {
    console.error("❌ Erreur /admin-stats/accounts/:method:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /admin-stats/revenus/evolution
 */
router.get("/revenus/evolution", verifyToken, isAdmin, async (req, res) => {
  try {
    const q = await db.query(
      `SELECT
         TO_CHAR(DATE_TRUNC('month', expiration), 'YYYY-MM') AS mois,
         COALESCE(SUM(amount),0) AS total
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise')
         AND upgrade_status = 'validé'
         AND expiration IS NOT NULL
         AND DATE_PART('year', expiration) = DATE_PART('year', CURRENT_DATE)
       GROUP BY DATE_TRUNC('month', expiration)
       ORDER BY mois`
    );
    res.json(q.rows);
  } catch (err) {
    console.error("❌ Erreur /admin-stats/revenus/evolution:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /admin-stats/overview
 */
router.get("/overview", verifyToken, isAdmin, async (req, res) => {
  try {
    const totalUsersQ = await db.query(`SELECT COUNT(*) AS total FROM users`);

    const activePremiumQ = await db.query(
      `SELECT COUNT(*) AS total
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise')
         AND upgrade_status = 'validé'
         AND (expiration IS NULL OR expiration >= CURRENT_DATE)`
    );

    const revenuesQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'validé'
         AND created_at <= CURRENT_DATE`
    );

    const pendingQ = await db.query(
      `SELECT COUNT(*) AS total
       FROM users
       WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'en attente'`
    );

    const currentQ = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM users
         WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'validé'
           AND (expiration IS NULL OR expiration >= CURRENT_DATE)) AS active_premium,
        (SELECT COALESCE(SUM(amount),0) FROM users
         WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'validé'
           AND created_at <= CURRENT_DATE) AS revenues
    `);

    const prevQ = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users
         WHERE created_at < DATE_TRUNC('month', CURRENT_DATE)) AS total_users,
        (SELECT COUNT(*) FROM users
         WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'validé'
           AND (expiration IS NULL OR expiration >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 day')) AS active_premium,
        (SELECT COALESCE(SUM(amount),0) FROM users
         WHERE plan IN ('Starter','Pro','Business','Enterprise') AND upgrade_status = 'validé'
           AND created_at < DATE_TRUNC('month', CURRENT_DATE)) AS revenues
    `);

    res.json({
      totalUsers:    Number(totalUsersQ.rows[0].total),
      activePremium: Number(activePremiumQ.rows[0].total),
      revenues:      Number(revenuesQ.rows[0].total),
      pending:       Number(pendingQ.rows[0].total),
      growth: {
        totalUsers:    { current: Number(currentQ.rows[0].total_users    || 0), previous: Number(prevQ.rows[0].total_users    || 0) },
        activePremium: { current: Number(currentQ.rows[0].active_premium || 0), previous: Number(prevQ.rows[0].active_premium || 0) },
        revenues:      { current: Number(currentQ.rows[0].revenues       || 0), previous: Number(prevQ.rows[0].revenues       || 0) },
      },
    });
  } catch (err) {
    console.error("❌ Erreur /admin-stats/overview:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── GET /admin-stats/clients ──
router.get('/clients', verifyToken, isAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT COUNT(*)::int AS total FROM clients');
    res.json({ total: rows[0].total });
  } catch (err) {
    console.error('GET /admin-stats/clients:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /admin-stats/commandes ──
router.get('/commandes', verifyToken, isAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                                     AS total,
        COUNT(*) FILTER (WHERE status IN ('en_attente','confirmee'))::int AS en_attente,
        COUNT(*) FILTER (WHERE status = 'recue')::int                    AS recues,
        COALESCE(SUM(total), 0)::numeric                                  AS valeur_totale
      FROM commandes
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /admin-stats/commandes:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /admin-stats/livraisons ──
router.get('/livraisons', verifyToken, isAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                                      AS total,
        COUNT(*) FILTER (WHERE status = 'en_transit')::int                AS en_transit,
        COUNT(*) FILTER (WHERE status = 'livree')::int                    AS livrees,
        COUNT(*) FILTER (WHERE status = 'probleme')::int                  AS problemes,
        COUNT(*) FILTER (
          WHERE status = 'en_transit'
          AND created_at < NOW() - INTERVAL '3 days'
        )::int                                                             AS en_retard
      FROM livraisons
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /admin-stats/livraisons:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ── GET /admin-stats/business ── MRR, churn, conversion, limites
router.get('/business', verifyToken, isAdmin, async (req, res) => {
  try {
    const db = require('../db');

    // MRR par plan (revenus récurrents mensuels)
    const mrrQ = await db.query(`
      SELECT
        plan,
        COUNT(*)::int AS nb_actifs,
        COALESCE(SUM(amount), 0)::numeric AS mrr_total
      FROM users
      WHERE upgrade_status = 'validé'
        AND plan IN ('Starter','Pro','Business')
        AND (expiration IS NULL OR expiration >= CURRENT_DATE)
      GROUP BY plan
      ORDER BY mrr_total DESC
    `);

    // Taux de conversion Free → payant
    const convQ = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE plan = 'Free')::int                              AS free_count,
        COUNT(*) FILTER (WHERE plan IN ('Starter','Pro','Business')
                           AND upgrade_status = 'validé')::int                  AS paid_count,
        COUNT(*) FILTER (WHERE upgrade_status = 'en attente')::int              AS pending_count,
        COUNT(*) FILTER (WHERE upgrade_status = 'expiré')::int                  AS churned_count,
        COUNT(*)::int                                                             AS total_count
      FROM users
      WHERE role != 'admin'
    `);
    const c = convQ.rows[0];
    const conversionRate = c.total_count > 0
      ? ((c.paid_count / c.total_count) * 100).toFixed(1)
      : '0.0';
    const churnRate = (c.paid_count + c.churned_count) > 0
      ? ((c.churned_count / (c.paid_count + c.churned_count)) * 100).toFixed(1)
      : '0.0';

    // Qui approche la limite 5 produits (Free → cible de conversion)
    const nearLimitQ = await db.query(`
      SELECT u.id, u.username, u.company_name, u.phone, COUNT(p.id)::int AS nb_produits
      FROM users u
      LEFT JOIN products p ON p.user_id = u.id
      WHERE u.plan = 'Free' AND u.upgrade_status != 'en attente'
      GROUP BY u.id, u.username, u.company_name, u.phone
      HAVING COUNT(p.id) >= 4
      ORDER BY nb_produits DESC
      LIMIT 10
    `);

    // Nouveaux inscrits 30 derniers jours
    const growthQ = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_30d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int  AS new_7d
      FROM users WHERE role != 'admin'
    `);

    // Abonnements expirant dans 7 jours
    const expiringQ = await db.query(`
      SELECT COUNT(*)::int AS expiring_soon
      FROM users
      WHERE plan IN ('Starter','Pro','Business')
        AND upgrade_status = 'validé'
        AND expiration BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
    `);

    res.json({
      mrr:          mrrQ.rows,
      mrr_total:    mrrQ.rows.reduce((s, r) => s + parseFloat(r.mrr_total), 0),
      conversion: {
        rate:         conversionRate + '%',
        free_count:   c.free_count,
        paid_count:   c.paid_count,
        pending_count: c.pending_count,
        churned_count: c.churned_count,
        total_count:  c.total_count,
      },
      churn_rate:     churnRate + '%',
      near_limit:     nearLimitQ.rows,
      growth:         growthQ.rows[0],
      expiring_soon:  expiringQ.rows[0].expiring_soon,
    });
  } catch (err) {
    console.error('GET /admin-stats/business:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
