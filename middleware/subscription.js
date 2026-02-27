const db = require("../db");

async function checkSubscription(req, res, next) {
  try {
    // 🔓 Le super_admin n'est jamais bloqué
    if (req.user.role === "super_admin") {
      return next();
    }

    if (!req.user.shop_id) {
      return res.status(403).json({ message: "Boutique introuvable" });
    }

    const { rows } = await db.query(
      `SELECT status, expires_at
       FROM subscriptions
       WHERE shop_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [req.user.shop_id]
    );

    if (rows.length === 0) {
      return res.status(403).json({ message: "Aucun abonnement trouvé" });
    }

    const subscription = rows[0];

    if (subscription.status !== "active") {
      return res.status(403).json({ message: "Abonnement inactif" });
    }

    if (
      subscription.expires_at &&
      new Date(subscription.expires_at) < new Date()
    ) {
      return res.status(403).json({ message: "Abonnement expiré" });
    }

    next();

  } catch (err) {
    console.error("Erreur checkSubscription:", err);
    res.status(500).json({ message: "Erreur serveur abonnement" });
  }
}

module.exports = checkSubscription;
