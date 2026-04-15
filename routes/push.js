// routes/push.js — Web Push Notifications (amélioré)
// Ajout : alertes proactives stock faible + crédits en retard
const express     = require('express');
const router      = express.Router();
const db          = require('../db');
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

// ── GET /push/vapid-key ──
router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// ── POST /push/subscribe ──
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

// ── DELETE /push/unsubscribe ──
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

// ══════════════════════════════════════
// ENVOI PUSH À UN UTILISATEUR
// ══════════════════════════════════════
async function sendPushToUser(userId, payload) {
  if (!webpush) return;
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

// ══════════════════════════════════════
// ALERTES PROACTIVES (appelé périodiquement)
// ══════════════════════════════════════

// ── POST /push/check-alerts ── Vérifier et envoyer les alertes
// Appeler via un cron ou à chaque login
router.post('/check-alerts', verifyToken, async (req, res) => {
  const userId = req.user.id;
  const alerts = [];

  try {
    // 1. Produits stock faible (≤ 3)
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
        body: lowStock.length + ' produit' + (lowStock.length > 1 ? 's' : '') + ' bientôt épuisé' + (lowStock.length > 1 ? 's' : '') + ' : ' + names,
        type: 'stock',
        url: '/#stock',
      });
    }

    // 2. Crédits en retard (due_date dépassée)
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

    // 3. Produits en rupture totale
    const { rows: outOfStock } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM products
       WHERE user_id = $1 AND deleted_at IS NULL AND stock = 0`,
      [userId]
    );

    if (outOfStock[0].cnt > 0) {
      alerts.push({
        title: '🔴 Rupture de stock',
        body: outOfStock[0].cnt + ' produit' + (outOfStock[0].cnt > 1 ? 's' : '') + ' à 0 — pensez à réapprovisionner',
        type: 'stock',
        url: '/#stock',
      });
    }

    // Envoyer les push
    for (const alert of alerts) {
      await sendPushToUser(userId, alert);
    }

    // Aussi sauvegarder dans notifications (persistant)
    for (const alert of alerts) {
      await db.query(
        `INSERT INTO notifications (user_id, type, title, message, action_url, boutique_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [userId, alert.type, alert.title, alert.body, alert.url, req.user.boutique_id || null]
      );
    }

    res.json({ alerts_sent: alerts.length, alerts });
  } catch (err) {
    console.error('POST /push/check-alerts:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
