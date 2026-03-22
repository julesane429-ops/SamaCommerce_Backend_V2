// middleware/checkSubscription.js
// ─────────────────────────────────────────────────────────────
// requirePlan(feature) — vérifie que le plan de l'utilisateur
// inclut la feature demandée et que l'abonnement est actif.
//
// requirePlan('rapports')  → bloque Free et Starter
// requirePlan('team')      → bloque tous sauf Business
//
// Usage :
//   router.get('/export', verifyToken, requirePlan('export'), ...)
// ─────────────────────────────────────────────────────────────

const db            = require('../db');
const { hasFeature, PAID_PLANS } = require('./planConfig');

const GRACE_DAYS = 1; // jours de grâce après expiration

// Cache court pour éviter une requête DB par requête API
const _planCache = new Map();
const CACHE_TTL  = 2 * 60 * 1000; // 2 minutes

async function getUserPlan(userId) {
  const cached = _planCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const { rows } = await db.query(
    'SELECT plan, upgrade_status, expiration FROM users WHERE id = $1',
    [userId]
  );
  const data = rows[0] || null;
  if (data) _planCache.set(userId, { data, expiresAt: Date.now() + CACHE_TTL });
  return data;
}

// Invalider le cache après changement de plan (appelé depuis auth.js)
function invalidatePlanCache(userId) {
  _planCache.delete(userId);
}

function requirePlan(feature) {
  return async function (req, res, next) {
    // Admin et employés héritent du plan de la boutique → passent toujours
    if (!req.user)                 return next();
    if (req.user.role === 'admin') return next();
    if (req.user.isEmployee)       return next();

    try {
      const user = await getUserPlan(req.user.id);
      if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });

      const plan   = user.plan || 'Free';
      const status = user.upgrade_status;

      // Abonnement en attente de validation
      if (PAID_PLANS.includes(plan) && status === 'en attente') {
        return res.status(402).json({
          error:   'Validation en cours',
          code:    'PENDING_VALIDATION',
          message: 'Votre abonnement est en cours de validation (sous 24h).',
        });
      }

      // Abonnement expiré (avec grâce)
      if (PAID_PLANS.includes(plan) && user.expiration) {
        const expDate  = new Date(user.expiration);
        const graceCut = new Date();
        graceCut.setDate(graceCut.getDate() - GRACE_DAYS);

        if (expDate < graceCut) {
          return res.status(402).json({
            error:            'Abonnement expiré',
            code:             'SUBSCRIPTION_EXPIRED',
            message:          'Votre abonnement a expiré. Renouvelez pour continuer.',
            expired_at:       user.expiration,
            upgrade_required: true,
          });
        }
      }

      // Vérifier que le plan inclut la feature
      if (!hasFeature(plan, feature)) {
        return res.status(402).json({
          error:            'Plan insuffisant',
          code:             'PLAN_INSUFFICIENT',
          feature,
          current_plan:     plan,
          message:          `La fonctionnalité "${feature}" n'est pas incluse dans votre plan ${plan}.`,
          upgrade_required: true,
        });
      }

      next();
    } catch (err) {
      console.error('requirePlan:', err.message);
      next(); // fail-open sur erreur DB
    }
  };
}

// Alias pour rétrocompatibilité avec l'ancien middleware
const requirePremium = requirePlan('rapports');

module.exports = requirePlan;
module.exports.requirePremium    = requirePremium;
module.exports.invalidatePlanCache = invalidatePlanCache;
