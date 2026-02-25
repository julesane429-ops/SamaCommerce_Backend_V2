const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const sendEmail = require("../utils/mailer");

/* ======================================================
   🔐 HELPERS
====================================================== */

// Middleware authentification
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Token manquant" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id: decoded.id,
      shop_id: decoded.shop_id || decoded.id, // compat V1
      role: decoded.role,
      username: decoded.username
    };

    next();
  } catch (err) {
    return res.status(403).json({ error: "Token invalide" });
  }
}

// Middleware admin
function isAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Accès réservé aux administrateurs" });
  }
  next();
}

/* ======================================================
   📝 INSCRIPTION
====================================================== */

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
    upgrade_status = "validé"
  } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  try {
    const existingUser = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: "Utilisateur déjà existant" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // 1️⃣ Création utilisateur
    const userResult = await pool.query(
      `INSERT INTO users 
        (username, password, company_name, phone, role, status, plan, 
         payment_status, payment_method, expiration, amount, upgrade_status) 
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) 
       RETURNING *`,
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

    const user = userResult.rows[0];

    // 2️⃣ Création boutique automatique
    const shopResult = await pool.query(
      `INSERT INTO shops (name, owner_id)
       VALUES ($1, $2)
       RETURNING id`,
      [company_name || username, user.id]
    );

    const shopId = shopResult.rows[0].id;

    // 3️⃣ Lier user → shop
    await pool.query(
      `UPDATE users SET shop_id = $1 WHERE id = $2`,
      [shopId, user.id]
    );

    res.status(201).json({
      message: "Compte créé avec succès",
      user: {
        id: user.id,
        username: user.username,
        shop_id: shopId
      }
    });

  } catch (err) {
    console.error("❌ Erreur inscription :", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🔑 LOGIN + 2FA
====================================================== */

router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, password, role, company_name, phone, 
              status, plan, upgrade_status, shop_id 
       FROM users WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    const user = result.rows[0];

    if (user.status === "Bloqué") {
      return res.status(403).json({
        error: "Votre compte est bloqué."
      });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: "Mot de passe incorrect" });
    }

    /* ---------- Vérification 2FA ---------- */
    const settings = await pool.query(
      "SELECT twofa_enabled FROM admin_settings WHERE admin_id = $1 LIMIT 1",
      [user.id]
    );

    const twofaEnabled = settings.rows[0]?.twofa_enabled || false;

    if (twofaEnabled && user.role === "admin") {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 5 * 60 * 1000);

      await pool.query(
        `INSERT INTO twofa_codes (user_id, code, expires_at) 
         VALUES ($1, $2, $3)`,
        [user.id, code, expires]
      );

      await sendEmail(
        user.username,
        "Votre code de connexion (2FA)",
        `Voici votre code : ${code} (valable 5 minutes)`
      );

      return res.json({
        twofa_required: true,
        userId: user.id
      });
    }

    /* ---------- JWT AVEC SHOP_ID ---------- */
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        shop_id: user.shop_id || user.id
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        company_name: user.company_name,
        phone: user.phone,
        plan: user.plan,
        upgrade_status: user.upgrade_status,
        shop_id: user.shop_id
      }
    });

  } catch (err) {
    console.error("❌ Erreur login :", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   👤 INFOS UTILISATEUR CONNECTÉ
====================================================== */

router.get("/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, company_name, phone, role, status, 
              plan, payment_status, payment_method, expiration, 
              amount, upgrade_status, shop_id
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error("❌ Erreur /me :", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   👑 ADMIN - GESTION UTILISATEURS
====================================================== */

// Liste users (admin seulement)
router.get("/users", authenticateToken, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, company_name, phone, role, 
             status, plan, payment_status, 
             expiration, upgrade_status, shop_id
      FROM users
      ORDER BY id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bloquer
router.put("/users/:id/block", authenticateToken, isAdmin, async (req, res) => {
  const result = await pool.query(
    "UPDATE users SET status = 'Bloqué' WHERE id = $1 RETURNING *",
    [req.params.id]
  );
  res.json(result.rows[0]);
});

// Activer
router.put("/users/:id/activate", authenticateToken, isAdmin, async (req, res) => {
  const result = await pool.query(
    "UPDATE users SET status = 'Actif' WHERE id = $1 RETURNING *",
    [req.params.id]
  );
  res.json(result.rows[0]);
});

// Supprimer
router.delete("/users/:id", authenticateToken, isAdmin, async (req, res) => {
  await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  res.json({ message: "Utilisateur supprimé" });
});

/* ======================================================
   👑 ADMIN - APPROUVER / REJETER UPGRADE
====================================================== */

// ✅ Approuver upgrade utilisateur
router.put('/upgrade/:userId/approve', authenticateToken, isAdmin, async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `UPDATE users
       SET plan = 'Premium',
           upgrade_status = 'validé',
           payment_status = 'À jour'
       WHERE id = $1
       RETURNING id, username, plan, upgrade_status, payment_status`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json({
      message: "Upgrade validé avec succès",
      user: result.rows[0]
    });

  } catch (err) {
    console.error("❌ Erreur approveUpgrade:", err);
    res.status(500).json({ error: err.message });
  }
});


// ❌ Rejeter upgrade utilisateur
router.put('/upgrade/:userId/reject', authenticateToken, isAdmin, async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `UPDATE users
       SET upgrade_status = 'rejeté',
           plan = 'Free'
       WHERE id = $1
       RETURNING id, username, plan, upgrade_status`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json({
      message: "Upgrade rejeté avec succès",
      user: result.rows[0]
    });

  } catch (err) {
    console.error("❌ Erreur rejectUpgrade:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🔄 UPGRADE
====================================================== */

router.put("/upgrade", authenticateToken, async (req, res) => {
  const { phone, payment_method, amount, expiration } = req.body;

  const result = await pool.query(
    `UPDATE users
     SET phone=$1, plan='Premium',
         payment_method=$2, amount=$3,
         expiration=$4, upgrade_status='en attente'
     WHERE id=$5
     RETURNING id, username, plan, upgrade_status`,
    [phone, payment_method, amount, expiration, req.user.id]
  );

  res.json({
    message: "Demande d’upgrade enregistrée",
    user: result.rows[0]
  });
});

/* ======================================================
   🔐 VERIFY 2FA
====================================================== */

router.post("/verify-2fa", async (req, res) => {
  const { userId, code } = req.body;

  const q = await pool.query(
    `SELECT * FROM twofa_codes 
     WHERE user_id=$1 AND code=$2 
       AND used=false AND expires_at>NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [userId, code]
  );

  if (q.rows.length === 0) {
    return res.status(400).json({ error: "Code invalide ou expiré" });
  }

  await pool.query(
    "UPDATE twofa_codes SET used=true WHERE id=$1",
    [q.rows[0].id]
  );

  const u = await pool.query(
    "SELECT id, username, role, shop_id FROM users WHERE id=$1",
    [userId]
  );

  const user = u.rows[0];

  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      shop_id: user.shop_id || user.id
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  res.json({ token, user });
});

module.exports = router;
