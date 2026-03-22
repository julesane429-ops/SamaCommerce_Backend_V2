const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const sendEmail = require("../utils/mailer");
const crypto = require('crypto');

// -- Rate limiter inline (max 10 tentatives / IP / 15 min) --
const _rlMap = new Map();
const RL_WIN = 15 * 60 * 1000;
const RL_MAX = 10;
function loginRateLimit(req, res, next) {
  const ip  = req.ip || req.socket && req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let e = _rlMap.get(ip);
  if (!e || now > e.r) e = { c: 0, r: now + RL_WIN };
  e.c++;
  _rlMap.set(ip, e);
  if (_rlMap.size > 5000) { for (const [k,v] of _rlMap) { if (now > v.r) _rlMap.delete(k); } }
  if (e.c > RL_MAX) {
    const wait = Math.ceil((e.r - now) / 60000);
    return res.status(429).json({ error: "Trop de tentatives. Reessayez dans " + wait + " minute(s)." });
  }
  next();
}
function resetLimit(ip) { _rlMap.delete(ip); }

// ==========================
//   Inscription
// ==========================
router.post("/register", async (req, res) => {
  const {
    username, password, company_name, phone,
    role = "user", status = "Actif", plan = "Free",
    payment_status = "À jour", payment_method,
    expiration, amount = 0.0, upgrade_status = "validé"
  } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Champs manquants", details: "username ou password vide." });
  }

  try {
    const existingUser = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: "Utilisateur déjà existant", details: `'${username}' est déjà pris.` });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users 
        (username, password, company_name, phone, role, status, plan, payment_status, payment_method, expiration, amount, upgrade_status) 
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) 
       RETURNING id, username, company_name, phone, role, status, plan, payment_status, payment_method, expiration, amount, upgrade_status`,
      [username, hashedPassword, company_name||null, phone||null, role, status, plan,
       payment_status, payment_method||null, expiration||null, amount, upgrade_status]
    );

    res.status(201).json({ message: "Compte créé avec succès", user: result.rows[0] });
  } catch (err) {
    console.error("❌ Erreur inscription :", err.message);
    res.status(500).json({ error: "Erreur serveur", details: err.message });
  }
});

// ==========================
//   Connexion (avec 2FA)
// ==========================
router.post("/login", loginRateLimit, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  try {
    const result = await pool.query(
      "SELECT id, username, password, role, company_name, phone, status, plan, upgrade_status FROM users WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    const user = result.rows[0];

    if (user.status === "Bloqué") {
      return res.status(403).json({ error: "Votre compte est bloqué. Veuillez contacter l'administrateur." });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: "Mot de passe incorrect" });
    }

    // Vérifier 2FA
    const settings = await pool.query(
      "SELECT twofa_enabled FROM admin_settings WHERE admin_id = $1 LIMIT 1",
      [user.id]
    );
    const twofaEnabled = settings.rows[0]?.twofa_enabled || false;

    if (twofaEnabled && user.role === "admin") {
      const code    = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 5 * 60 * 1000);

      await pool.query(
        `INSERT INTO twofa_codes (user_id, code, expires_at) VALUES ($1, $2, $3)`,
        [user.id, code, expires]
      );
      await sendEmail(
        user.username,
        "Votre code de connexion (2FA) - Sama Commerce",
        `Bonjour,\n\nVoici votre code : ${code}\n\nValable 5 minutes.`
      );

      return res.json({ twofa_required: true, userId: user.id, message: "Code 2FA envoyé" });
    }

    // ── Génération JWT ──
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Réinitialiser le compteur de tentatives après succès
    resetLimit(req.ip || req.connection?.remoteAddress || 'unknown');

    // ── Génération Refresh Token ──
    let refreshToken = null;
    try {
      refreshToken = crypto.randomBytes(48).toString('hex');
      const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 jours
      await pool.query(
        'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, refreshToken, refreshExpiry]
      );
    } catch (rtErr) {
      // Si la table n'existe pas encore, on continue sans refresh token
      console.warn('⚠️ refresh_tokens non disponible:', rtErr.message);
      refreshToken = null;
    }

    res.json({
      token,
      refresh_token: refreshToken,
      user: {
        id:             user.id,
        email:          user.username,
        role:           user.role,
        company_name:   user.company_name,
        phone:          user.phone,
        plan:           user.plan,
        upgrade_status: user.upgrade_status
      }
    });
  } catch (err) {
    console.error("❌ Erreur connexion :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
//   Middleware Auth
// ==========================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ==========================
//   Middleware Admin
// ==========================
function isAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Accès réservé aux administrateurs" });
  }
  next();
}

// ==========================
//   Liste des utilisateurs
// ==========================
router.get("/users", authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, company_name, phone, role, status, plan,
             payment_status, payment_method, expiration, amount, upgrade_status
      FROM users
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Erreur /users :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Bloquer
router.put("/users/:id/block", authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await pool.query("UPDATE users SET status = 'Bloqué' WHERE id = $1 RETURNING *", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Réactiver
router.put("/users/:id/activate", authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await pool.query("UPDATE users SET status = 'Actif', payment_status = 'À jour' WHERE id = $1 RETURNING *", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Supprimer
router.delete("/users/:id", authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING *", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json({ message: "Utilisateur supprimé", user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rappel
router.post("/users/:id/reminder", authenticateToken, isAdmin, async (req, res) => {
  try {
    const user = await pool.query("SELECT username FROM users WHERE id = $1", [req.params.id]);
    if (!user.rows.length) return res.status(404).json({ error: "Utilisateur introuvable" });
    console.log(`📩 Rappel → ${user.rows[0].username}`);
    res.json({ message: `Rappel envoyé à ${user.rows[0].username}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================
//   /auth/me
// ==========================
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, company_name, phone, role, status, plan,
              payment_status, payment_method, expiration, amount, upgrade_status
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ /auth/me :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
//   PATCH /auth/me — Modifier profil
// ==========================
router.patch("/me", authenticateToken, async (req, res) => {
  try {
    const { company_name, phone, current_password, new_password } = req.body;
    const userId = req.user.id;

    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    if (!rows.length) return res.status(404).json({ error: "Utilisateur introuvable" });
    const user = rows[0];

    if (new_password) {
      if (!current_password) return res.status(400).json({ error: "Mot de passe actuel requis" });
      const valid = await bcrypt.compare(current_password, user.password);
      if (!valid)              return res.status(401).json({ error: "Mot de passe actuel incorrect" });
      if (new_password.length < 6) return res.status(400).json({ error: "Minimum 6 caractères" });
    }

    const fields = [], values = [];
    let i = 1;
    if (company_name !== undefined) { fields.push(`company_name = $${i++}`); values.push(company_name); }
    if (phone !== undefined)        { fields.push(`phone = $${i++}`);        values.push(phone); }
    if (new_password) {
      const hashed = await bcrypt.hash(new_password, 10);
      fields.push(`password = $${i++}`); values.push(hashed);
    }
    if (!fields.length) return res.status(400).json({ error: "Aucun champ à mettre à jour" });

    values.push(userId);
    const result = await pool.query(
      `UPDATE users SET ${fields.join(", ")} WHERE id = $${i}
       RETURNING id, username, company_name, phone, role, plan, expiration, upgrade_status`,
      values
    );
    res.json({ message: "Profil mis à jour", user: result.rows[0] });
  } catch (err) {
    console.error("❌ PATCH /auth/me:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ==========================
//   GET /auth/me/stats
// ==========================
router.get("/me/stats", authenticateToken, async (req, res) => {
  try {
    const uid = req.user.id;
    const [prodQ, venteQ, creditQ] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total FROM products WHERE user_id = $1", [uid]),
      pool.query("SELECT COUNT(*)::int AS total, COALESCE(SUM(total),0) AS ca FROM sales WHERE user_id = $1", [uid]),
      pool.query("SELECT COUNT(*)::int AS total FROM sales WHERE user_id = $1 AND payment_method = 'credit' AND paid = false", [uid]),
    ]);
    res.json({
      nb_produits:      prodQ.rows[0].total,
      nb_ventes:        venteQ.rows[0].total,
      ca_total:         Number(venteQ.rows[0].ca),
      credits_ouverts:  creditQ.rows[0].total,
    });
  } catch (err) {
    console.error("❌ GET /auth/me/stats:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ==========================
//   Upgrade Premium
// ==========================
router.put("/upgrade", authenticateToken, async (req, res) => {
  const { phone, payment_method, amount } = req.body;
  if (!phone || !payment_method || !amount) {
    return res.status(400).json({ error: "Champs manquants" });
  }
  try {
    // Enregistrer la demande en attente — l'expiration est fixée par l'admin à la validation
    const result = await pool.query(
      `UPDATE users SET phone=$1, payment_method=$2, amount=$3,
       upgrade_status='en attente', payment_status='En attente'
       WHERE id=$4
       RETURNING id, username, company_name, phone, plan, payment_method, amount, expiration, payment_status, upgrade_status`,
      [phone, payment_method, amount, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json({ message: "Demande d'upgrade enregistrée", user: result.rows[0] });
  } catch (err) {
    console.error("❌ Erreur upgrade:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/upgrade/:userId/approve', authenticateToken, isAdmin, async (req, res) => {
  try {
    // Durée configurable via req.body.months (défaut 1 mois)
    const months = parseInt(req.body.months || '1');
    const expiration = new Date();
    expiration.setMonth(expiration.getMonth() + months);

    const result = await pool.query(
      `UPDATE users
       SET plan='Premium', upgrade_status='validé',
           expiration=$2, payment_status='À jour'
       WHERE id=$1
       RETURNING id, username, plan, upgrade_status, expiration`,
      [req.params.userId, expiration.toISOString().split('T')[0]]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json({ message: "Upgrade validé", user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/upgrade/:userId/reject', authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE users SET upgrade_status='rejeté', plan='Free' WHERE id=$1 RETURNING id, username, plan, upgrade_status",
      [req.params.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json({ message: "Upgrade rejeté", user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================
//   2FA
// ==========================
router.post("/verify-2fa", async (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !code) return res.status(400).json({ error: "Champs manquants" });

  try {
    const q = await pool.query(
      `SELECT * FROM twofa_codes
       WHERE user_id=$1 AND code=$2 AND used=false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [userId, code]
    );
    if (!q.rows.length) return res.status(400).json({ error: "Code invalide ou expiré" });

    await pool.query("UPDATE twofa_codes SET used=true WHERE id=$1", [q.rows[0].id]);

    const u = await pool.query(
      "SELECT id, username, role, company_name, phone, plan, upgrade_status FROM users WHERE id=$1",
      [userId]
    );
    const user = u.rows[0];
    const token = jwt.sign({ id:user.id, username:user.username, role:user.role }, process.env.JWT_SECRET, { expiresIn:"7d" });
    res.json({ token, user });
  } catch (err) {
    console.error("❌ Erreur verify-2fa:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
//   Refresh Token
// ==========================
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token manquant' });

  try {
    const { rows } = await pool.query(
      `SELECT rt.*, u.id as uid, u.username, u.role, u.status
       FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id
       WHERE rt.token=$1 AND rt.revoked=false AND rt.expires_at > NOW()`,
      [refresh_token]
    );
    if (!rows.length) return res.status(401).json({ error: 'Refresh token invalide ou expiré' });

    const row = rows[0];
    if (row.status === 'Bloqué') return res.status(403).json({ error: 'Compte bloqué' });

    const newToken        = jwt.sign({ id:row.uid, username:row.username, role:row.role }, process.env.JWT_SECRET, { expiresIn:'7d' });
    const newRefreshToken = crypto.randomBytes(48).toString('hex');
    const newExpiry       = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await pool.query('UPDATE refresh_tokens SET revoked=true WHERE token=$1', [refresh_token]);
    await pool.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)', [row.uid, newRefreshToken, newExpiry]);

    res.json({ token: newToken, refresh_token: newRefreshToken });
  } catch (err) {
    console.error('POST /auth/refresh:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================
//   Logout
// ==========================
router.post('/logout', async (req, res) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    await pool.query('UPDATE refresh_tokens SET revoked=true WHERE token=$1', [refresh_token]).catch(()=>{});
  }
  res.json({ message: 'Déconnecté' });
});

module.exports = router;
