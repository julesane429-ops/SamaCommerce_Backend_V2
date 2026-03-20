// ═══════════════════════════════════════════════════════════
// routes/demo.js — Mode démo avec données pré-remplies
// ═══════════════════════════════════════════════════════════
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
 
const DEMO_EMAIL    = 'demo@samacommerce.sn';
const DEMO_PASSWORD = 'demo1234';
 
// ── POST /demo/login ── Connexion démo instantanée
router.post('/login', async (req, res) => {
  try {
    // Trouver ou créer le compte démo
    let { rows } = await db.query(
      "SELECT * FROM users WHERE username = $1 AND is_demo = true",
      [DEMO_EMAIL]
    );
 
    let demoUser = rows[0];
 
    if (!demoUser) {
      const hashed = await bcrypt.hash(DEMO_PASSWORD, 10);
      const r = await db.query(`
        INSERT INTO users (username, password, company_name, role, plan, status, is_demo, upgrade_status)
        VALUES ($1, $2, 'Boutique Démo', 'user', 'Premium', 'Actif', true, 'validé')
        RETURNING *
      `, [DEMO_EMAIL, hashed]);
      demoUser = r.rows[0];
 
      // Injecter des données démo
      await seedDemoData(demoUser.id);
    } else {
      // Réinitialiser si la dernière réinitialisation date de >24h
      const lastReset = demoUser.demo_reset_at;
      const hoursSince = lastReset
        ? (Date.now() - new Date(lastReset)) / (1000 * 3600)
        : Infinity;
      if (hoursSince > 24) {
        await resetDemoData(demoUser.id);
      }
    }
 
    const token = jwt.sign(
      { id: demoUser.id, username: demoUser.username, role: 'user' },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
 
    res.json({
      token,
      user: {
        id:           demoUser.id,
        email:        demoUser.username,
        company_name: demoUser.company_name,
        plan:         demoUser.plan,
        role:         'user',
        is_demo:      true,
      },
      message: '👋 Bienvenue dans la démo ! Toutes les données sont fictives.',
    });
  } catch (err) {
    console.error('POST /demo/login:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
 
// ── Injecter données démo ──
async function seedDemoData(userId) {
  try {
    // Catégories
    const cats = await db.query(`
      INSERT INTO categories (name, emoji, user_id)
      VALUES
        ('Habits',      '👕', $1),
        ('Cosmétiques', '💄', $1),
        ('Chaussures',  '👠', $1),
        ('Alimentation','🍎', $1)
      RETURNING id
    `, [userId]);
 
    const [c1, c2, c3, c4] = cats.rows;
 
    // Produits
    await db.query(`
      INSERT INTO products (name, category_id, price, price_achat, stock, user_id)
      VALUES
        ('Robe Wax',        $2, 5000,  2500, 12, $1),
        ('Jean Slim',       $2, 8000,  4000, 8,  $1),
        ('T-Shirt Coton',   $2, 3500,  1500, 20, $1),
        ('Crème Karitée',   $3, 2500,  800,  15, $1),
        ('Parfum Rose',     $3, 7500,  3000, 6,  $1),
        ('Baskets Nike',    $4, 25000, 12000,4,  $1),
        ('Sandales Cuir',   $4, 12000, 5000, 9,  $1),
        ('Riz Local 5kg',   $5, 3000,  1800, 30, $1),
        ('Huile Palme 1L',  $5, 1500,  900,  2,  $1)
    `, [userId, c1.id, c2.id, c3.id, c4.id]);
 
    // Ventes sur les 30 derniers jours (simulées)
    const { rows: prods } = await db.query(
      'SELECT id, price FROM products WHERE user_id = $1', [userId]
    );
 
    for (let i = 0; i < 25; i++) {
      const prod   = prods[Math.floor(Math.random() * prods.length)];
      const qte    = Math.ceil(Math.random() * 3);
      const days   = Math.floor(Math.random() * 30);
      const date   = new Date(); date.setDate(date.getDate() - days);
      const methods = ['especes','wave','orange','especes','especes'];
      const method = methods[Math.floor(Math.random() * methods.length)];
 
      await db.query(`
        INSERT INTO sales (product_id, quantity, total, payment_method, user_id, paid, created_at)
        VALUES ($1, $2, $3, $4, $5, true, $6)
      `, [prod.id, qte, prod.price * qte, method, userId, date]);
    }
 
    // Un crédit impayé
    const creditProd = prods[0];
    await db.query(`
      INSERT INTO sales (product_id, quantity, total, payment_method, user_id, paid, client_name, client_phone, due_date)
      VALUES ($1, 2, $2, 'credit', $3, false, 'Fatou Diallo', '+221771234567', NOW() + INTERVAL '2 days')
    `, [creditProd.id, creditProd.price * 2, userId]);
 
    await db.query(
      'UPDATE users SET demo_reset_at = NOW() WHERE id = $1', [userId]
    );
  } catch (err) {
    console.error('Erreur seedDemoData:', err);
  }
}
 
async function resetDemoData(userId) {
  await db.query('DELETE FROM sales    WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM products WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM categories WHERE user_id = $1', [userId]);
  await seedDemoData(userId);
}
 
module.exports = router;
 
