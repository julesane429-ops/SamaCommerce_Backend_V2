const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const sendEmail = require("../utils/mailer");

// ==========================
//   Inscription (Admin ou public)
// ==========================
router.post("/register", async (req, res) => {
  const {
    username,
    password,
    company_name,
    phone,
    role = "user",
    status = "Actif",
    plan = "Free",
    payment_status = "À jour",
    payment_method,
    expiration,
    amount = 0.0,
    upgrade_status = "validé" // ✅ par défaut validé (Free = pas besoin de validation)
  } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      error: "Champs manquants",
      details: "Le champ 'username' ou 'password' est vide."
    });
  }

  try {
    // Vérifie si l'utilisateur existe déjà
    const existingUser = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );
    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        error: "Utilisateur déjà existant",
        details: `Le nom d'utilisateur '${username}' est déjà pris.`
      });
    }

    // Hash du mot de passe
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insertion avec TOUS les champs
    const result = await pool.query(
      `INSERT INTO users 
        (username, password, company_name, phone, role, status, plan, payment_status, payment_method, expiration, amount, upgrade_status) 
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) 
       RETURNING id, username, company_name, phone, role, status, plan, payment_status, payment_method, expiration, amount, upgrade_status`,
      [
        username,
        hashedPassword,
        company_name || null,
        phone || null,
        role,
        status,
        plan,
        payment_status,
        payment_method || null,
        expiration || null,
        amount,
        upgrade_status
      ]
    );

    res.status(201).json({
      message: "Compte créé avec succès",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("❌ Erreur lors de l'inscription :", err);
    res.status(500).json({
      error: "Erreur serveur",
      details: err.message || err
    });
  }
});

// ==========================
//   Connexion
// ==========================
// ==========================
//   Connexion avec 2FA
// ==========================
router.post("/login", async (req, res) => {
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

    // 🚫 Vérifier si le compte est bloqué
    if (user.status === "Bloqué") {
      return res.status(403).json({ error: "Votre compte est bloqué. Veuillez contacter l’administrateur." });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: "Mot de passe incorrect" });
    }

    // Vérifier si 2FA activée
    const settings = await pool.query(
      "SELECT twofa_enabled FROM admin_settings WHERE admin_id = $1 LIMIT 1",
      [user.id]
    );

    const twofaEnabled = settings.rows[0]?.twofa_enabled || false;

    if (twofaEnabled && user.role === "admin") {
      // Générer un code 6 chiffres
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 5 * 60 * 1000); // expire dans 5 min

      await pool.query(
        `INSERT INTO twofa_codes (user_id, code, expires_at) VALUES ($1, $2, $3)`,
        [user.id, code, expires]
      );

      await sendEmail(
  user.username, // email de l’utilisateur
  "Votre code de connexion (2FA) - Ma Boutique",
  `Bonjour,\n\nVoici votre code de connexion : ${code}\n\nIl est valable 5 minutes.\n\nÀ bientôt !`
);

      return res.json({
        twofa_required: true,
        userId: user.id,
        message: "Code 2FA envoyé par email"
      });
    }

    // Sinon → connexion normale
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.username,
        role: user.role,
        company_name: user.company_name,
        phone: user.phone,
        plan: user.plan,
        upgrade_status: user.upgrade_status
      }
    });
  } catch (err) {
    console.error("❌ Erreur lors de la connexion :", err);
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
router.get("/users", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, 
        username, 
        company_name, 
        phone, 
        role, 
        status, 
        plan, 
        payment_status, 
        payment_method, 
        expiration, 
        amount,
        upgrade_status
      FROM users
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des utilisateurs :", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
//   Gestion des utilisateurs (Admin)
// ==========================

// Bloquer un utilisateur
router.put("/users/:id/block", authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE users SET status = 'Bloqué' WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Réactiver un utilisateur
router.put("/users/:id/activate", authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE users SET status = 'Actif', payment_status = 'À jour' WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer un utilisateur
router.delete("/users/:id", authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM users WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json({ message: "Utilisateur supprimé", user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envoyer un rappel
router.post("/users/:id/reminder", authenticateToken, isAdmin, async (req, res) => {
  try {
    const user = await pool.query("SELECT username FROM users WHERE id = $1", [req.params.id]);
    if (user.rows.length === 0) return res.status(404).json({ error: "Utilisateur introuvable" });

    console.log(`📩 Rappel envoyé à ${user.rows[0].username}`);
    res.json({ message: `Rappel envoyé à ${user.rows[0].username}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
//   Infos utilisateur connecté
// ==========================
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, company_name, phone, role, status, plan, 
              payment_status, payment_method, expiration, amount, upgrade_status 
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Erreur lors de /auth/me :", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
//   Upgrade vers Premium
// ==========================
router.put("/upgrade", authenticateToken, async (req, res) => {
  const { phone, payment_method, amount, expiration } = req.body;

  if (!phone || !payment_method || !amount || !expiration) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET phone = $1,
           plan = 'Premium',
           payment_method = $2,
           amount = $3,
           expiration = $4,
           upgrade_status = 'en attente',
           payment_status = 'À jour'
       WHERE id = $5
       RETURNING id, username, company_name, phone, plan, payment_method, amount, expiration, payment_status, upgrade_status`,
      [phone, payment_method, amount, expiration, req.user.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Utilisateur introuvable" });

    res.json({ message: "Demande d’upgrade enregistrée", user: result.rows[0] });
  } catch (err) {
    console.error("❌ Erreur upgrade:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// Approuver upgrade utilisateur
// ==========================
router.put('/upgrade/:userId/approve', authenticateToken, isAdmin, async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `UPDATE users
       SET plan = 'Premium', upgrade_status = 'validé'
       WHERE id = $1
       RETURNING id, username, plan, upgrade_status`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json({ message: "Upgrade validé avec succès", user: result.rows[0] });
  } catch (err) {
    console.error("❌ Erreur approveUpgrade:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// Rejeter upgrade utilisateur
// ==========================
router.put('/upgrade/:userId/reject', authenticateToken, isAdmin, async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `UPDATE users
       SET upgrade_status = 'rejeté', plan = 'Free'
       WHERE id = $1
       RETURNING id, username, plan, upgrade_status`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json({ message: "Upgrade rejeté avec succès", user: result.rows[0] });
  } catch (err) {
    console.error("❌ Erreur rejectUpgrade:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
//   Vérifier le code 2FA
// ==========================
router.post("/verify-2fa", async (req, res) => {
  const { userId, code } = req.body;

  if (!userId || !code) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  try {
    const q = await pool.query(
      `SELECT * FROM twofa_codes 
       WHERE user_id = $1 AND code = $2 AND used = false 
         AND expires_at > NOW() 
       ORDER BY created_at DESC LIMIT 1`,
      [userId, code]
    );

    if (q.rows.length === 0) {
      return res.status(400).json({ error: "Code invalide ou expiré" });
    }

    // Marquer comme utilisé
    await pool.query(`UPDATE twofa_codes SET used = true WHERE id = $1`, [q.rows[0].id]);

    // Récupérer l'utilisateur
    const u = await pool.query(
      "SELECT id, username, role, company_name, phone, plan, upgrade_status FROM users WHERE id = $1",
      [userId]
    );
    const user = u.rows[0];

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({
      token,
      user
    });
  } catch (err) {
    console.error("❌ Erreur verify-2fa:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
