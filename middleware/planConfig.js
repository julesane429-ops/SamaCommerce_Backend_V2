// middleware/planConfig.js
// ─────────────────────────────────────────────────────────────
// Source de vérité unique pour les plans et leurs limites.
// ─────────────────────────────────────────────────────────────

const PLANS = {
  Free: {
    label: 'Gratuit', price: 0,
    products_limit: 5, members_limit: 0, boutiques_limit: 1,
    features: {
      ventes: true, stock: true, categories: true, caisse: false,
      credits: false, clients: false, fournisseurs: false, commandes: false,
      livraisons: false, rapports: false, photos: false, export: false,
      whatsapp: false, team: false, finance: false, multi_boutique: false,
    },
  },
  Starter: {
    label: 'Starter', price: 2500,
    products_limit: 30, members_limit: 0, boutiques_limit: 1,
    features: {
      ventes: true, stock: true, categories: true, caisse: true,
      credits: true, clients: true, fournisseurs: false, commandes: false,
      livraisons: false, rapports: false, photos: true, export: false,
      whatsapp: false, team: false, finance: false, multi_boutique: false,
    },
  },
  Pro: {
    label: 'Pro', price: 5000,
    products_limit: Infinity, members_limit: 0, boutiques_limit: 1,
    features: {
      ventes: true, stock: true, categories: true, caisse: true,
      credits: true, clients: true, fournisseurs: true, commandes: true,
      livraisons: true, rapports: true, photos: true, export: true,
      whatsapp: true, team: false, finance: true, multi_boutique: false,
    },
  },
  Business: {
    label: 'Business', price: 9000,
    products_limit: Infinity, members_limit: 3, boutiques_limit: 1,
    features: {
      ventes: true, stock: true, categories: true, caisse: true,
      credits: true, clients: true, fournisseurs: true, commandes: true,
      livraisons: true, rapports: true, photos: true, export: true,
      whatsapp: true, team: true, finance: true, multi_boutique: false,
    },
  },
  Enterprise: {
    label: 'Enterprise', price: 15000,
    // ✅ ILLIMITÉ : Infinity pour boutiques ET membres
    products_limit: Infinity,
    members_limit: Infinity,
    boutiques_limit: Infinity,
    features: {
      ventes: true, stock: true, categories: true, caisse: true,
      credits: true, clients: true, fournisseurs: true, commandes: true,
      livraisons: true, rapports: true, photos: true, export: true,
      whatsapp: true, team: true, finance: true, multi_boutique: true,
    },
  },
};

const PAID_PLANS = ['Starter', 'Pro', 'Business', 'Enterprise'];

function getPlan(planName)            { return PLANS[planName] || PLANS.Free; }
function hasFeature(planName, feat)   { return getPlan(planName).features[feat] === true; }
function getProductLimit(planName)    { return getPlan(planName).products_limit; }
function getMembersLimit(planName)    { return getPlan(planName).members_limit; }
function getBoutiquesLimit(planName)  { return getPlan(planName).boutiques_limit ?? 1; }

module.exports = { PLANS, PAID_PLANS, getPlan, hasFeature, getProductLimit, getMembersLimit, getBoutiquesLimit };
