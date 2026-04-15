// routes/activityLogs.js — Journal d'activité des employés
const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');

// ── Helper : enregistrer un log (utilisable par les autres routes) ──
async function logActivity(req, { action, entity_type, entity_id, details, severity = 'info' }) {
  try {
    const actorName = req.user?.username || req.user?.company_name || 'Système';
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';

    await db.query(
      `INSERT INTO activity_logs
         (user_id, boutique_id, actor_name, action, entity_type, entity_id, details, severity, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        req.user.id,
        req.user.boutique_id || null,
        actorName,
        action,
        entity_type || null,
        entity_id || null,
        details ? JSON.stringify(details) : null,
        severity,
        ip
      ]
    );
  } catch (err) {
    console.error('logActivity error:', err.message);
    // Ne pas bloquer la requête si le log échoue
  }
}

// ── GET /activity-logs ── Lister les logs (owner uniquement)
router.get('/', verifyToken, async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page || '1'));
    const limit    = Math.min(100, Math.max(1, parseInt(req.query.limit || '50')));
    const offset   = (page - 1) * limit;
    const severity = req.query.severity; // 'info', 'warning', 'critical'
    const days     = parseInt(req.query.days || '30');

    let where = 'al.user_id = $1 AND al.created_at >= NOW() - $2::interval';
    let params = [req.user.id, `${days} days`];

    if (req.user.boutique_id) {
      where = '(al.boutique_id = $1 OR (al.boutique_id IS NULL AND al.user_id = $3)) AND al.created_at >= NOW() - $2::interval';
      params.push(req.user.id);
    }

    if (severity && ['info', 'warning', 'critical'].includes(severity)) {
      where += ` AND al.severity = $${params.length + 1}`;
      params.push(severity);
    }

    const { rows } = await db.query(`
      SELECT al.*, u.username AS actor_email
      FROM activity_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE ${where}
      ORDER BY al.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    // Compteurs par sévérité
    const { rows: stats } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE severity = 'info')     AS info_count,
        COUNT(*) FILTER (WHERE severity = 'warning')  AS warning_count,
        COUNT(*) FILTER (WHERE severity = 'critical') AS critical_count
      FROM activity_logs al
      WHERE ${where}
    `, params);

    res.json({
      logs: rows,
      stats: stats[0] || {},
      page,
      limit,
    });
  } catch (err) {
    console.error('GET /activity-logs:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
module.exports.logActivity = logActivity;
