// routes/push.js — Web Push Notifications (robuste)
const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');

let webpush = null;
let _vapidConfigured = false;

try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      'mailto:' + (process.env.EMAIL_USER || 'admin@samacommerce.com'),
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    _vapidConfigured = true;
  } else {
    console.warn('⚠️ VAPID keys non configurées — push désactivé');
  }
} catch {
  console.warn('⚠️ web-push non installé — push notifications désactivées');
}

router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// ── POST /push/subscribe ──
// FIX : ne renvoie plus 500 si push désactivé
router.post('/subscribe', verifyToken, async (req, res) => {
  if (!_vapidConfigured) {
    return res.json({ message: 'Push désactivé — VAPID non configuré', skipped: true });
  }

  const { subscription } = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Subscription invalide' });
  }

  try {
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, subscription_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET subscription_json = $3, updated_at = NOW()`,
      [req.user.id, subscription.endpoint, JSON.stringify(subscription)]
    );
    res.json({ message: 'Abonnement push enregistré' });
  } catch (err) {
    console.error('POST /push/subscribe:', err.message);
    res.json({ message: 'Push non disponible', skipped: true });
  }
});

router.delete('/unsubscribe', verifyToken, async (req, res) => {
  const { endpoint } = req.body;
  try {
    await db.query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [req.user.id, endpoint]
    );
    res.json({ message: 'Abonnement supprimé' });
  } catch (err) {
    res.json({ message: 'Push non disponible', skipped: true });
  }
});

async function sendPushToUser(userId, payload) {
  if (!webpush || !_vapidConfigured) return;
  try {
    const { rows } = await db.query(
      'SELECT id, subscription_json FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );
    const sends = rows.map(async row => {
      try {
        const sub = JSON.parse(row.subscription_json);
        await webpush.sendNotification(sub, JSON.stringify(payload));
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await db.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
        }
      }
    });
    await Promise.allSettled(sends);
  } catch (err) {
    console.error('sendPushToUser:', err.message);
  }
}

router.post('/check-alerts', verifyToken, async (req, res) => {
  const userId = req.user.id;
  const alerts = [];

  try {
    const { rows: lowStock } = await db.query(
      `SELECT name, stock FROM products
       WHERE user_id = $1 AND deleted_at IS NULL AND stock > 0 AND stock <= 3
       ORDER BY stock ASC LIMIT 5`,
      [userId]
    );

    if (lowStock.length) {
      const names = lowStock.map(p => p.name).join(', ');
      alerts.push({
        title: '⚠️ Stock faible',
        body: lowStock.length + ' produit' + (lowStock.length > 1 ? 's' : '') + ' bientôt épuisé : ' + names,
        type: 'stock',
        url: '/#stock',
      });
    }

    const { rows: lateCredits } = await db.query(
      `SELECT client_name, total, due_date FROM sales
       WHERE user_id = $1 AND paid = false AND payment_method = 'credit'
         AND due_date IS NOT NULL AND due_date < CURRENT_DATE
       ORDER BY due_date ASC LIMIT 5`,
      [userId]
    );

    if (lateCredits.length) {
      const totalDue = lateCredits.reduce((s, c) => s + parseFloat(c.total || 0), 0);
      alerts.push({
        title: '💳 Crédits en retard',
        body: lateCredits.length + ' crédit' + (lateCredits.length > 1 ? 's' : '') + ' en retard — ' + Math.round(totalDue).toLocaleString('fr-FR') + ' F',
        type: 'credit',
        url: '/#credits',
      });
    }

    for (const alert of alerts) {
      await sendPushToUser(userId, alert);
    }

    try {
      for (const alert of alerts) {
        await db.query(
          `INSERT INTO notifications (user_id, type, title, message, action_url, boutique_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, alert.type, alert.title, alert.body, alert.url, req.user.boutique_id || null]
        );
      }
    } catch (_) { }

    res.json({ alerts_sent: alerts.length, alerts });
  } catch (err) {
    console.error('POST /push/check-alerts:', err.message);
    res.json({ alerts_sent: 0, alerts: [], error: err.message });
  }
});

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
