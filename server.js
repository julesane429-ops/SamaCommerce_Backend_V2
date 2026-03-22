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
const clientsRoutes      = require('./routes/clients');
const fournisseursRoutes = require('./routes/fournisseurs');
const commandesRoutes    = require('./routes/commandes');
const livraisonsRoutes   = require('./routes/livraisons');
const membersRoutes = require('./routes/members');
const returnsRoutes = require('./routes/returns');
const demoRoutes    = require('./routes/demo');
const caisseRoutes  = require('./routes/caisse');
const customerOrdersRoutes = require('./routes/customerOrders');
const employeeProxy        = require('./middleware/employeeProxy');

// ── CORS ──
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Boutique-Id'],
  credentials:    true,
}));

app.options('*', cors());
app.use(express.json());

// Proxy employé : maintenant intégré dans middleware/auth.js (verifyToken)
// Supprimé d'ici pour éviter qu'il tourne avant le décodage JWT

// Contexte boutique : injecte req.user.boutique_id sur toutes les requêtes
const boutiqueContext = require('./middleware/boutiqueContext');
app.use(boutiqueContext);

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
app.use('/members',  membersRoutes);
app.use('/returns',  returnsRoutes);
app.use('/demo',     demoRoutes);
app.use('/caisse',   caisseRoutes);
 
app.use('/customer-orders', customerOrdersRoutes);
app.use('/deliveries',      deliveriesRoutes);
app.use('/deliverymen',     deliverymenRoutes);
app.use('/push',            require('./routes/push'));
app.use('/boutiques',        require('./routes/boutiques'));

// Servir les fichiers statiques
app.use(express.static(path.join(process.cwd())));


// ══════════════════════════════════════
// CRON ABONNEMENTS — toutes les nuits à minuit
// ══════════════════════════════════════
const { sendEmail, emailRappel7J, emailRappel3J, emailExpiration } = require('./utils/mailer');
const { invalidatePlanCache } = require('./middleware/checkSubscription');

cron.schedule('0 0 * * *', async () => {
  console.log('⏰ Cron abonnements: démarrage...');
  try {

    // ── 1. RAPPEL J-7 ──────────────────────────────────────
    const in7 = await pool.query(`
      SELECT id, username, company_name, phone, expiration
      FROM users
      WHERE plan IN ('Starter','Pro','Business','Enterprise')
        AND upgrade_status = 'validé'
        AND expiration::date = CURRENT_DATE + INTERVAL '7 days'
    `);
    for (const u of in7.rows) {
      const { subject, html } = emailRappel7J(u);
      await sendEmail(u.username, subject, html);
      await pool.query(
        `INSERT INTO alerts (user_id, type, message, days) VALUES ($1,'upcoming',$2,$3)
         ON CONFLICT DO NOTHING`,
        [u.id, 'Abonnement expire dans 7 jours', 7]
      );
    }
    console.log(`📧 Rappels J-7: ${in7.rows.length}`);

    // ── 2. RAPPEL J-3 ──────────────────────────────────────
    const in3 = await pool.query(`
      SELECT id, username, company_name, phone, expiration
      FROM users
      WHERE plan IN ('Starter','Pro','Business','Enterprise')
        AND upgrade_status = 'validé'
        AND expiration::date = CURRENT_DATE + INTERVAL '3 days'
    `);
    for (const u of in3.rows) {
      const { subject, html } = emailRappel3J(u);
      await sendEmail(u.username, subject, html);
      await pool.query(
        `INSERT INTO alerts (user_id, type, message, days) VALUES ($1,'upcoming',$2,$3)
         ON CONFLICT DO NOTHING`,
        [u.id, 'Abonnement expire dans 3 jours', 3]
      );
    }
    console.log(`📧 Rappels J-3: ${in3.rows.length}`);

    // ── 3. EXPIRATION J-0 : passer en Free ─────────────────
    const expired = await pool.query(`
      SELECT id, username, company_name, phone, expiration
      FROM users
      WHERE plan IN ('Starter','Pro','Business','Enterprise')
        AND upgrade_status = 'validé'
        AND expiration::date < CURRENT_DATE
    `);
    for (const u of expired.rows) {
      // Rétrograder en Free + invalider le cache plan
      await pool.query(
        `UPDATE users
         SET plan = 'Free', upgrade_status = 'expiré', payment_status = 'Expiré'
         WHERE id = $1`,
        [u.id]
      );
      invalidatePlanCache(u.id);
      // Email d'expiration
      const { subject, html } = emailExpiration(u);
      await sendEmail(u.username, subject, html);
      // Alerte admin
      await pool.query(
        `INSERT INTO alerts (user_id, type, message, days) VALUES ($1,'late',$2,$3)
         ON CONFLICT DO NOTHING`,
        [u.id, 'Abonnement expiré — compte rétrogradé en Free', 0]
      );
    }
    console.log(`🔻 Expirations traitées: ${expired.rows.length}`);

    // ── 4. RELANCE J+3 ─────────────────────────────────────
    const lapsed3 = await pool.query(`
      SELECT id, username, company_name, expiration
      FROM users
      WHERE plan = 'Free'
        AND upgrade_status = 'expiré'
        AND expiration::date = CURRENT_DATE - INTERVAL '3 days'
    `);
    for (const u of lapsed3.rows) {
      await sendEmail(u.username,
        `⏰ Votre boutique vous attend — Revenez en Premium — Sama Commerce`,
        `<p>Bonjour ${u.company_name || u.username}, votre abonnement a expiré il y a 3 jours. Renouvelez sur <a href="${process.env.FRONTEND_URL || 'https://samacommerce-frontend-v2-1.onrender.com'}">Sama Commerce</a>.</p>`
      );
    }
    console.log(`📧 Relances J+3: ${lapsed3.rows.length}`);

    console.log('✅ Cron abonnements terminé.');
  } catch (err) {
    console.error('❌ Cron erreur:', err.message);
  }
});

app.listen(port, () => {
  console.log(`🚀 Backend lancé sur http://localhost:${port}`);
});
