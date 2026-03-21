const express = require('express');
const cors    = require('cors');
require('dotenv').config();
const cron = require('node-cron');
const pool = require('./db');
const path = require('path');

const { deliveries: deliveriesRoutes, deliverymen: deliverymenRoutes } = require('./routes/deliveries');

const app  = express();
const port = process.env.PORT || 4000;

// ── Routes importées ──
const adminWithdrawalsRoutes = require('./routes/adminWithdrawals');
const alertsRoutes           = require('./routes/alerts');

// ── Nouvelles routes ──
const clientsRoutes        = require('./routes/clients');
const fournisseursRoutes   = require('./routes/fournisseurs');
const commandesRoutes      = require('./routes/commandes');
const livraisonsRoutes     = require('./routes/livraisons');
const membersRoutes        = require('./routes/members');
const returnsRoutes        = require('./routes/returns');
const demoRoutes           = require('./routes/demo');
const caisseRoutes         = require('./routes/caisse');
const customerOrdersRoutes = require('./routes/customerOrders');
const employeeProxy        = require('./middleware/employeeProxy');

// ── CORS ──────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://samacommerce-frontend-v2-1.onrender.com',
  'http://localhost:3000',
  'http://localhost:4000',
  'http://127.0.0.1:3000',
  'http://localhost:5000',
  'http://localhost:5500',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || origin === 'null') return callback(null, true);
    const isAllowed = allowedOrigins.some(o => origin.startsWith(o));
    return isAllowed
      ? callback(null, true)
      : callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:    true,
}));

app.options('*', cors());
app.use(express.json());

// ── Proxy employé ─────────────────────────────────────────────────────────
app.use(employeeProxy);

// ══════════════════════════════════════════════════════════════════════════
// ROUTES EXISTANTES
// ══════════════════════════════════════════════════════════════════════════
app.use('/auth',              require('./routes/auth'));
app.use('/products',          require('./routes/products'));
app.use('/categories',        require('./routes/categories'));
app.use('/sales',             require('./routes/sales'));
app.use('/tontines',          require('./routes/tontines'));
app.use('/stats',             require('./routes/stats'));
app.use('/admin-stats',       require('./routes/adminStats'));
app.use('/admin-withdrawals', adminWithdrawalsRoutes);
app.use('/admin-transfers',   require('./routes/adminTransfers'));
app.use('/admin-settings',    require('./routes/adminSettings'));
app.use('/alerts',            alertsRoutes);

// ══════════════════════════════════════════════════════════════════════════
// NOUVELLES ROUTES
// ══════════════════════════════════════════════════════════════════════════
app.use('/clients',         clientsRoutes);
app.use('/fournisseurs',    fournisseursRoutes);
app.use('/commandes',       commandesRoutes);
app.use('/livraisons',      livraisonsRoutes);
app.use('/members',         membersRoutes);
app.use('/returns',         returnsRoutes);
app.use('/demo',            demoRoutes);
app.use('/caisse',          caisseRoutes);
app.use('/customer-orders', customerOrdersRoutes);
app.use('/deliveries',      deliveriesRoutes);
app.use('/deliverymen',     deliverymenRoutes);

// ── Fichiers statiques ────────────────────────────────────────────────────
// CORRECTION #5 : process.cwd() exposait tout le code source du backend
// (db.js, routes/, middleware/, package.json…) via HTTP.
// On sert uniquement un dossier "public/" dédié s'il existe.
// Si le backend ne sert pas de fichiers statiques (cas Render séparé),
// cette ligne peut être entièrement supprimée.
app.use(express.static(path.join(__dirname, 'public')));

// ── Route 404 générique pour les API ──────────────────────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

// ══════════════════════════════════════════════════════════════════════════
// CRON : recalcul alertes à minuit
// ══════════════════════════════════════════════════════════════════════════
cron.schedule('0 0 * * *', async () => {
  console.log('⏰ Cron: recalcul des alertes...');
  try {
    // CORRECTION #3 : l'ancien code faisait DELETE FROM alerts SANS WHERE,
    // ce qui supprimait chaque nuit les alertes de TOUS les utilisateurs,
    // y compris les alertes non encore lues.
    //
    // Nouvelle stratégie :
    //   1. Supprimer uniquement les anciennes alertes (> 30 jours)
    //   2. Supprimer les doublons du jour pour les users concernés
    //      avant de réinsérer les nouvelles, pour éviter les doublons
    //      si le cron tourne plusieurs fois.

    // 1. Nettoyer les alertes très anciennes (> 30 jours)
    await pool.query(
      "DELETE FROM alerts WHERE created_at < NOW() - INTERVAL '30 days'"
    );

    // 2. Récupérer les users Premium en retard
    const late = await pool.query(
      `SELECT id, username, expiration, CURRENT_DATE - expiration AS days_late
       FROM users
       WHERE plan = 'Premium' AND expiration < CURRENT_DATE`
    );

    for (const u of late.rows) {
      // Supprimer l'alerte du jour pour ce user (évite doublons si cron rejoué)
      await pool.query(
        "DELETE FROM alerts WHERE user_id = $1 AND type = 'late' AND DATE(created_at) = CURRENT_DATE",
        [u.id]
      );
      await pool.query(
        `INSERT INTO alerts (user_id, type, message, days)
         VALUES ($1, 'late', $2, $3)`,
        [u.id, `Paiement en retard de ${u.days_late} jours`, u.days_late]
      );
    }

    // 3. Récupérer les users Premium dont l'échéance est dans 3 jours
    const upcoming = await pool.query(
      `SELECT id, username, expiration, expiration - CURRENT_DATE AS days_left
       FROM users
       WHERE plan = 'Premium'
         AND expiration BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'`
    );

    for (const u of upcoming.rows) {
      // Supprimer l'alerte du jour pour ce user
      await pool.query(
        "DELETE FROM alerts WHERE user_id = $1 AND type = 'upcoming' AND DATE(created_at) = CURRENT_DATE",
        [u.id]
      );
      await pool.query(
        `INSERT INTO alerts (user_id, type, message, days)
         VALUES ($1, 'upcoming', $2, $3)`,
        [u.id, `Paiement dû dans ${u.days_left} jours`, u.days_left]
      );
    }

    console.log('✅ Cron: alertes mises à jour !');
  } catch (err) {
    console.error('❌ Cron erreur:', err);
  }
});

app.listen(port, () => {
  console.log(`🚀 Backend lancé sur http://localhost:${port}`);
});
