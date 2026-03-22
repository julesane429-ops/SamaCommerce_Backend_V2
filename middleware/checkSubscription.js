// middleware/checkSubscription.js
// ─────────────────────────────────────────────────────────────
// Vérifie que l'abonnement Premium de l'utilisateur n'est pas
// expiré. Si expiré → 402 Payment Required avec détail.
//
// Routes Premium-only (ex: rapports avancés, équipe, export) :
//   router.get('/export', verifyToken, requirePremium, ...)
// ─────────────────────────────────────────────────────────────

const db = require('../db');

// Délai de grâce : 1 jour après expiration avant blocage
const GRACE_DAYS = 1;

async function requirePremium(req, res, next) {
  // Admins et employés passent toujours
  if (!req.user)            return next();
  if (req.user.role === 'admin') return next();
  if (req.user.isEmployee)  return next(); // L'employé hérite du plan de la boutique

  try {
    const { rows } = await db.query(
      'SELECT plan, upgrade_status, expiration FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows.length) return res.status(401).json({ error: 'Utilisateur introuvable' });

    const user = rows[0];

    // Plan Free → bloquer
    if (user.plan !== 'Premium') {
      return res.status(402).json({
        error:            'Abonnement requis',
        code:             'PLAN_FREE',
        message:          'Cette fonctionnalité nécessite un abonnement Premium.',
        upgrade_required: true,
      });
    }

    // Premium en attente de validation → bloquer
    if (user.upgrade_status === 'en attente') {
      return res.status(402).json({
        error:   'Validation en cours',
        code:    'PENDING_VALIDATION',
        message: 'Votre demande Premium est en cours de validation (sous 24h).',
      });
    }

    // Premium expiré (avec grâce)
    if (user.expiration) {
      const expDate  = new Date(user.expiration);
      const graceCut = new Date();
      graceCut.setDate(graceCut.getDate() - GRACE_DAYS);

      if (expDate < graceCut) {
        return res.status(402).json({
          error:            'Abonnement expiré',
          code:             'SUBSCRIPTION_EXPIRED',
          message:          'Votre abonnement Premium a expiré. Renouvelez pour continuer.',
          expired_at:       user.expiration,
          upgrade_required: true,
        });
      }
    }

    next();
  } catch (err) {
    console.error('requirePremium:', err.message);
    next(); // fail-open sur erreur DB (ne pas bloquer l'app)
  }
}

module.exports = requirePremium;
