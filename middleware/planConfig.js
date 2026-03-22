// middleware/planConfig.js
// ─────────────────────────────────────────────────────────────
// Source de vérité unique pour les plans et leurs limites.
// Importé par checkSubscription, products, members, etc.
// ─────────────────────────────────────────────────────────────

const PLANS = {
  Free: {
    label:          'Gratuit',
    price:          0,
    products_limit: 5,
    members_limit:  0,       // pas d'employés
    features: {
      ventes:       true,
      stock:        true,
      categories:   true,
      caisse:       false,
      credits:      false,
      clients:      false,
      fournisseurs: false,
      commandes:    false,
      livraisons:   false,
      rapports:     false,
      photos:       false,
      export:       false,
      whatsapp:     false,
      team:         false,
      finance:      false,
    },
  },

  Starter: {
    label:          'Starter',
    price:          2500,
    products_limit: 30,
    members_limit:  0,
    features: {
      ventes:       true,
      stock:        true,
      categories:   true,
      caisse:       true,
      credits:      true,
      clients:      true,
      fournisseurs: false,
      commandes:    false,
      livraisons:   false,
      rapports:     false,
      photos:       true,
      export:       false,
      whatsapp:     false,
      team:         false,
      finance:      false,
    },
  },

  Pro: {
    label:          'Pro',
    price:          5000,
    products_limit: Infinity,
    members_limit:  0,
    features: {
      ventes:       true,
      stock:        true,
      categories:   true,
      caisse:       true,
      credits:      true,
      clients:      true,
      fournisseurs: true,
      commandes:    true,
      livraisons:   true,
      rapports:     true,
      photos:       true,
      export:       true,
      whatsapp:     true,
      team:         false,
      finance:      true,
    },
  },

  Business: {
    label:          'Business',
    price:          9000,
    products_limit: Infinity,
    members_limit:  3,
    features: {
      ventes:       true,
      stock:        true,
      categories:   true,
      caisse:       true,
      credits:      true,
      clients:      true,
      fournisseurs: true,
      commandes:    true,
      livraisons:   true,
      rapports:     true,
      photos:       true,
      export:       true,
      whatsapp:     true,
      team:         true,
      finance:      true,
    },
  },
};

// Plans considérés comme "actifs" (payants validés)
const PAID_PLANS = ['Starter', 'Pro', 'Business'];

// Retourne la config d'un plan (fallback sur Free si inconnu)
function getPlan(planName) {
  return PLANS[planName] || PLANS.Free;
}

// Vérifie si un plan a accès à une feature
function hasFeature(planName, feature) {
  const plan = getPlan(planName);
  return plan.features[feature] === true;
}

// Limite de produits pour un plan
function getProductLimit(planName) {
  return getPlan(planName).products_limit;
}

// Limite de membres pour un plan
function getMembersLimit(planName) {
  return getPlan(planName).members_limit;
}

module.exports = { PLANS, PAID_PLANS, getPlan, hasFeature, getProductLimit, getMembersLimit };
