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
       WHERE plan = 'Premium' AND upgrade_status = 'validé'`
    );

    const periodQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS period_total
       FROM users
       WHERE plan = 'Premium' AND upgrade_status = 'validé' ${
         period === "all" ? "" : periodFilter
       }`
    );

    const pendingQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS pending
       FROM users
       WHERE plan = 'Premium' AND upgrade_status = 'en attente'`
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
       WHERE plan = 'Premium'
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
 * Retourne les soldes par compte + résumé global
 */
router.get("/accounts", verifyToken, isAdmin, async (req, res) => {
  try {
    // 1. Abonnements Premium validés
    const payQ = await db.query(
      `SELECT payment_method, COALESCE(SUM(amount),0) AS total
       FROM users
       WHERE plan = 'Premium' AND upgrade_status = 'validé'
       GROUP BY payment_method`
    );
    const accounts = { orange: 0, wave: 0, cash: 0 };
    payQ.rows.forEach(r => {
      if (r.payment_method) accounts[r.payment_method] = Number(r.total);
    });

    // 2. Retraits validés
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

    // 3. Transferts internes
    const tQ = await db.query(
      `SELECT from_account, to_account, amount
       FROM admin_transfers
       WHERE admin_id = $1`,
      [req.user.id]
    );
    tQ.rows.forEach(r => {
      accounts[r.from_account] -= Number(r.amount);
      accounts[r.to_account] += Number(r.amount);
    });

    // 4. Résumé global
    const total = accounts.orange + accounts.wave + accounts.cash;

    // ✅ Entrées aujourd'hui (abonnements créés aujourd’hui)
    const entriesQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM users
       WHERE plan = 'Premium' 
         AND upgrade_status = 'validé'
         AND DATE(created_at) = CURRENT_DATE`
    );
    const entries = Number(entriesQ.rows[0].total);

    // ✅ Sorties aujourd'hui (retraits validés aujourd’hui)
    const withdrawalsQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM withdrawals
       WHERE admin_id = $1
         AND status = 'validé'
         AND DATE(created_at) = CURRENT_DATE`,
      [req.user.id]
    );
    const withdrawals = Number(withdrawalsQ.rows[0].total);

    // ✅ Bénéfice net
    const net = entries - withdrawals;

    res.json({
      accounts,
      total,
      entries,
      withdrawals,
      net,
    });
  } catch (err) {
    console.error("❌ Erreur /admin-stats/accounts:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /admin-stats/accounts/:method
 * Détails des transactions d’un compte spécifique
 */
router.get("/accounts/:method", verifyToken, isAdmin, async (req, res) => {
  try {
    const { method } = req.params;

    const subs = await db.query(
      `SELECT username, amount, payment_method, expiration, created_at
       FROM users
       WHERE plan = 'Premium' AND upgrade_status = 'validé' AND payment_method = $1
       ORDER BY expiration DESC NULLS LAST
       LIMIT 50`,
      [method]
    );

    const outs = await db.query(
      `SELECT amount, status, created_at
       FROM withdrawals
       WHERE admin_id = $1 AND status = 'validé' AND method = $2
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id, method]
    );

    const transfers = await db.query(
      `SELECT from_account, to_account, amount, created_at
       FROM admin_transfers
       WHERE admin_id = $1 AND (from_account = $2 OR to_account = $2)
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id, method]
    );

    res.json({
      subscriptions: subs.rows,
      withdrawals: outs.rows,
      transfers: transfers.rows,
    });
  } catch (err) {
    console.error("❌ Erreur /admin-stats/accounts/:method:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /admin-stats/revenus/evolution
 * Retourne les revenus groupés par mois pour l'année en cours
 */
router.get("/revenus/evolution", verifyToken, isAdmin, async (req, res) => {
  try {
    const q = await db.query(
      `SELECT 
         TO_CHAR(DATE_TRUNC('month', expiration), 'YYYY-MM') AS mois,
         COALESCE(SUM(amount),0) AS total
       FROM users
       WHERE plan = 'Premium' 
         AND upgrade_status = 'validé'
         AND expiration IS NOT NULL
         AND DATE_PART('year', expiration) = DATE_PART('year', CURRENT_DATE)
       GROUP BY DATE_TRUNC('month', expiration)
       ORDER BY mois`
    );

    res.json(q.rows); // [{ mois: "2025-01", total: 12000 }, ...]
  } catch (err) {
    console.error("❌ Erreur /admin-stats/revenus/evolution:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * GET /admin-stats/overview
 * Retourne les statistiques globales + comparaison avec mois précédent
 */
router.get("/overview", verifyToken, isAdmin, async (req, res) => {
  try {
    // Total utilisateurs (tous)
    const totalUsersQ = await db.query(`SELECT COUNT(*) AS total FROM users`);

    // Abonnés Premium actifs actuels
    const activePremiumQ = await db.query(
      `SELECT COUNT(*) AS total 
       FROM users
       WHERE plan = 'Premium'
         AND upgrade_status = 'validé'
         AND (expiration IS NULL OR expiration >= CURRENT_DATE)`
    );

    // Revenus validés (total jusqu’à aujourd’hui)
    const revenuesQ = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM users
       WHERE plan = 'Premium' AND upgrade_status = 'validé'
         AND created_at <= CURRENT_DATE`
    );

    // Abonnements en attente
    const pendingQ = await db.query(
      `SELECT COUNT(*) AS total
       FROM users
       WHERE plan = 'Premium' AND upgrade_status = 'en attente'`
    );

    // ✅ Snapshot mois courant (aujourd’hui)
    const currentQ = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) 
         FROM users
         WHERE plan = 'Premium'
           AND upgrade_status = 'validé'
           AND (expiration IS NULL OR expiration >= CURRENT_DATE)) AS active_premium,
        (SELECT COALESCE(SUM(amount),0) 
         FROM users
         WHERE plan = 'Premium' AND upgrade_status = 'validé'
           AND created_at <= CURRENT_DATE) AS revenues
    `);

    // ✅ Snapshot mois précédent (dernier jour du mois précédent)
    const prevQ = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM users
         WHERE created_at < DATE_TRUNC('month', CURRENT_DATE)) AS total_users,
        (SELECT COUNT(*) 
         FROM users
         WHERE plan = 'Premium'
           AND upgrade_status = 'validé'
           AND (expiration IS NULL OR expiration >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 day')) AS active_premium,
        (SELECT COALESCE(SUM(amount),0) 
         FROM users
         WHERE plan = 'Premium' AND upgrade_status = 'validé'
           AND created_at < DATE_TRUNC('month', CURRENT_DATE)) AS revenues
    `);

    res.json({
      totalUsers: Number(totalUsersQ.rows[0].total),
      activePremium: Number(activePremiumQ.rows[0].total),
      revenues: Number(revenuesQ.rows[0].total),
      pending: Number(pendingQ.rows[0].total),
      growth: {
        totalUsers: {
          current: Number(currentQ.rows[0].total_users || 0),
          previous: Number(prevQ.rows[0].total_users || 0),
        },
        activePremium: {
          current: Number(currentQ.rows[0].active_premium || 0),
          previous: Number(prevQ.rows[0].active_premium || 0),
        },
        revenues: {
          current: Number(currentQ.rows[0].revenues || 0),
          previous: Number(prevQ.rows[0].revenues || 0),
        },
      }
    });
  } catch (err) {
    console.error("❌ Erreur /admin-stats/overview:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});
// ═══════════════════════════════════════════════════════════
// PATCH routes/adminStats.js
// Ajouter ces 3 routes à la fin du fichier existant,
// avant module.exports = router;
// ═══════════════════════════════════════════════════════════

const verifyToken  = require('../middleware/auth');
const isAdmin      = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  next();
};

// ── GET /admin-stats/clients ──
// Nombre total de clients enregistrés
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
// Commandes en attente (en_attente + confirmee)
router.get('/commandes', verifyToken, isAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                                         AS total,
        COUNT(*) FILTER (WHERE status IN ('en_attente','confirmee'))::int     AS en_attente,
        COUNT(*) FILTER (WHERE status = 'recue')::int                        AS recues,
        COALESCE(SUM(total), 0)::numeric                                      AS valeur_totale
      FROM commandes
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /admin-stats/commandes:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /admin-stats/livraisons ──
// Livraisons en retard (en_transit depuis > 3 jours)
router.get('/livraisons', verifyToken, isAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int                                                                   AS total,
        COUNT(*) FILTER (WHERE status = 'en_transit')::int                             AS en_transit,
        COUNT(*) FILTER (WHERE status = 'livree')::int                                 AS livrees,
        COUNT(*) FILTER (WHERE status = 'probleme')::int                               AS problemes,
        COUNT(*) FILTER (
          WHERE status = 'en_transit'
          AND created_at < NOW() - INTERVAL '3 days'
        )::int                                                                          AS en_retard
      FROM livraisons
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /admin-stats/livraisons:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
