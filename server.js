const express = require('express');
const cors    = require('cors');
require('dotenv').config();
const cron = require('node-cron');
const pool = require('./db');
const path = require('path');

const app  = express();
const port = process.env.PORT || 4000;

// Servir les fichiers statiques
app.use(express.static(path.join(process.cwd())));

// ── Routes importées ──
const adminWithdrawalsRoutes = require('./routes/adminWithdrawals');
const alertsRoutes           = require('./routes/alerts');

// ── Nouvelles routes ──
const clientsRoutes      = require('./routes/clients');
const fournisseursRoutes = require('./routes/fournisseurs');
const commandesRoutes    = require('./routes/commandes');
const livraisonsRoutes   = require('./routes/livraisons');

// ── CORS ──
const allowedOrigins = [
  'https://samacommerce-frontend-v2-1.onrender.com',
  'http://localhost:3000',
  'http://localhost:4000',
  'http://127.0.0.1:3000',
  'http://localhost:5000',
  'http://localhost:5500',
];

console.log('ENV TEST:', process.env.DATABASE_URL);

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

// ══════════════════════════════════════
// ROUTES EXISTANTES
// ══════════════════════════════════════
app.use('/auth',             require('./routes/auth'));
app.use('/products',         require('./routes/products'));
app.use('/categories',       require('./routes/categories'));
app.use('/sales',            require('./routes/sales'));
app.use('/tontines',         require('./routes/tontines'));
app.use('/stats',            require('./routes/stats'));
app.use('/admin-stats',      require('./routes/adminStats'));
app.use('/admin-withdrawals', adminWithdrawalsRoutes);
app.use('/admin-transfers',  require('./routes/adminTransfers'));
app.use('/admin-settings',   require('./routes/adminSettings'));
app.use('/alerts',           alertsRoutes);

// ══════════════════════════════════════
// NOUVELLES ROUTES
// ══════════════════════════════════════
app.use('/clients',      clientsRoutes);
app.use('/fournisseurs', fournisseursRoutes);
app.use('/commandes',    commandesRoutes);
app.use('/livraisons',   livraisonsRoutes);

// ══════════════════════════════════════
// CRON : recalcul alertes à minuit
// ══════════════════════════════════════
cron.schedule('0 0 * * *', async () => {
  console.log('⏰ Cron: recalcul des alertes...');
  try {
    await pool.query('DELETE FROM alerts');

    const late = await pool.query(
      `SELECT id, username, expiration, CURRENT_DATE - expiration AS days_late
       FROM users
       WHERE plan = 'Premium' AND expiration < CURRENT_DATE`
    );
    for (const u of late.rows) {
      await pool.query(
        `INSERT INTO alerts (user_id, type, message, days)
         VALUES ($1,'late',$2,$3)`,
        [u.id, `Paiement en retard de ${u.days_late} jours`, u.days_late]
      );
    }

    const upcoming = await pool.query(
      `SELECT id, username, expiration, expiration - CURRENT_DATE AS days_left
       FROM users
       WHERE plan = 'Premium'
         AND expiration BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'`
    );
    for (const u of upcoming.rows) {
      await pool.query(
        `INSERT INTO alerts (user_id, type, message, days)
         VALUES ($1,'upcoming',$2,$3)`,
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
