// routes/push.js — Web Push Notifications
const express   = require('express');
const router    = express.Router();
const db        = require('../db');
const verifyToken = require('../middleware/auth');

let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      'mailto:' + (process.env.EMAIL_USER || 'admin@samacommerce.com'),
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  }
} catch {
  console.warn('⚠️ web-push non installé — push notifications désactivées');
}

// ── GET /push/vapid-key ── Clé publique VAPID pour le frontend
router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// ── POST /push/subscribe ── Enregistrer un abonnement push
router.post('/subscribe', verifyToken, async (req, res) => {
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
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /push/unsubscribe ── Supprimer un abonnement push
router.delete('/unsubscribe', verifyToken, async (req, res) => {
  const { endpoint } = req.body;
  try {
    await db.query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [req.user.id, endpoint]
    );
    res.json({ message: 'Abonnement supprimé' });
  } catch (err) {
    console.error('DELETE /push/unsubscribe:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Envoyer une notification push à un utilisateur (usage interne)
async function sendPushToUser(userId, payload) {
  if (!webpush) return;
  try {
    const { rows } = await db.query(
      'SELECT subscription_json FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );
    const sends = rows.map(async row => {
      try {
        const sub = JSON.parse(row.subscription_json);
        await webpush.sendNotification(sub, JSON.stringify(payload));
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          // Abonnement expiré — nettoyer
          await db.query(
            'DELETE FROM push_subscriptions WHERE subscription_json::text LIKE $1',
            ['%' + JSON.stringify(row.subscription_json?.endpoint || '').slice(1,-1) + '%']
          );
        }
      }
    });
    await Promise.allSettled(sends);
  } catch (err) {
    console.error('sendPushToUser:', err.message);
  }
}

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
