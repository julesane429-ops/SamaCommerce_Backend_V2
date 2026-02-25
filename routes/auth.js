const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const sendEmail = require("../utils/mailer");

/* ======================================================
   🔐 MIDDLEWARE AUTH
====================================================== */

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Token manquant" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded; // on garde tout le payload (type inclus)

    next();
  } catch (err) {
    return res.status(403).json({ error: "Token invalide" });
  }
}

/* ======================================================
   🔒 MIDDLEWARE ROLES
====================================================== */

function isSuperAdmin(req, res, next) {
  if (req.user.role !== "super_admin") {
    return res.status(403).json({ error: "Accès réservé au Super Admin" });
  }
  next();
}

function isOwner(req, res, next) {
  if (req.user.type !== "owner") {
    return res.status(403).json({ error: "Accès réservé au propriétaire" });
  }
  next();
}

function isAdmin(req, res, next) {
  // Compat ancienne logique admin = super_admin
  if (req.user.role !== "super_admin") {
    return res.status(403).json({ error: "Accès réservé aux administrateurs" });
  }
  next();
}

/* ======================================================
   📝 INSCRIPTION (OWNER)
====================================================== */

router.post("/register", async (req, res) => {
  const { username, password, company_name, phone } = req.body;

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

    // Création OWNER
    const userResult = await pool.query(
      `INSERT INTO users 
        (username, password, company_name, phone, role)
       VALUES ($1,$2,$3,$4,'owner')
       RETURNING *`,
      [username, hashedPassword, company_name || null, phone || null]
    );

    const user = userResult.rows[0];

    // Création shop
    const shopResult = await pool.query(
      `INSERT INTO shops (name, owner_id)
       VALUES ($1,$2)
       RETURNING id`,
      [company_name || username, user.id]
    );

    const shopId = shopResult.rows[0].id;

    await pool.query(
      `UPDATE users SET shop_id=$1 WHERE id=$2`,
      [shopId, user.id]
    );

    res.status(201).json({
      message: "Compte créé avec succès",
      user: {
        id: user.id,
        username: user.username,
        role: "owner",
        shop_id: shopId
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🔑 LOGIN AUTO USERS + EMPLOYEES
====================================================== */

router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  try {

    /* =========================
       1️⃣ RECHERCHE DANS USERS
    ========================== */
    const userResult = await pool.query(
      `SELECT id, username, password, role, company_name,
              phone, status, plan, shop_id
       FROM users WHERE username=$1`,
      [username]
    );

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];

      if (user.status === "Bloqué") {
        return res.status(403).json({ error: "Compte bloqué" });
      }

      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: "Mot de passe incorrect" });
      }

      // 2FA uniquement pour super_admin
      if (user.role === "super_admin") {
        const settings = await pool.query(
          "SELECT twofa_enabled FROM admin_settings WHERE admin_id=$1 LIMIT 1",
          [user.id]
        );

        const twofaEnabled = settings.rows[0]?.twofa_enabled || false;

        if (twofaEnabled) {
          const code = Math.floor(100000 + Math.random() * 900000).toString();
          const expires = new Date(Date.now() + 5 * 60 * 1000);

          await pool.query(
            `INSERT INTO twofa_codes (user_id, code, expires_at)
             VALUES ($1,$2,$3)`,
            [user.id, code, expires]
          );

          await sendEmail(
            user.username,
            "Code 2FA",
            `Votre code est : ${code}`
          );

          return res.json({ twofa_required: true, userId: user.id });
        }
      }

      // Déterminer type
      let type = "owner";
      if (user.role === "super_admin") type = "super_admin";

      const token = jwt.sign(
        {
          id: user.id,
          username: user.username,
          role: user.role,
          shop_id: user.shop_id,
          type
        },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
      );

      return res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          type,
          shop_id: user.shop_id
        }
      });
    }

    /* =========================
       2️⃣ RECHERCHE DANS EMPLOYEES
    ========================== */
    const empResult = await pool.query(
      `SELECT id, name, email, password, role, shop_id, is_active
       FROM employees WHERE email=$1`,
      [username]
    );

    if (empResult.rows.length === 0) {
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    const employee = empResult.rows[0];

    if (!employee.is_active) {
      return res.status(403).json({ error: "Employé désactivé" });
    }

    const validPassword = await bcrypt.compare(password, employee.password);
    if (!validPassword) {
      return res.status(401).json({ error: "Mot de passe incorrect" });
    }

    const token = jwt.sign(
      {
        id: employee.id,
        role: employee.role,
        shop_id: employee.shop_id,
        type: "employee"
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    return res.json({
      token,
      user: {
        id: employee.id,
        role: employee.role,
        type: "employee",
        shop_id: employee.shop_id
      }
    });

  } catch (err) {
    console.error("❌ Erreur login:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   👤 /ME (AUTO USERS + EMPLOYEES)
====================================================== */

router.get("/me", authenticateToken, async (req, res) => {

  if (req.user.type === "employee") {
    const emp = await pool.query(
      "SELECT id, name, email, role, shop_id FROM employees WHERE id=$1",
      [req.user.id]
    );
    return res.json(emp.rows[0]);
  }

  const user = await pool.query(
    `SELECT id, username, role, shop_id, plan
     FROM users WHERE id=$1`,
    [req.user.id]
  );

  res.json(user.rows[0]);
});

/* ======================================================
   👑 ADMIN (SUPER ADMIN ONLY)
====================================================== */

router.get("/users", authenticateToken, isSuperAdmin, async (req, res) => {
  const result = await pool.query(
    "SELECT id, username, role, plan, status FROM users ORDER BY id DESC"
  );
  res.json(result.rows);
});
/* ======================================================
   👑 SUPER ADMIN - GESTION UTILISATEURS
====================================================== */

// Bloquer un utilisateur (owner uniquement)
router.put("/users/:id/block", authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE users SET status = 'Bloqué' WHERE id = $1 AND role != 'super_admin' RETURNING *",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable ou protégé" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Réactiver
router.put("/users/:id/activate", authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE users SET status = 'Actif' WHERE id = $1 RETURNING *",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer (impossible de supprimer super_admin)
router.delete("/users/:id", authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM users WHERE id = $1 AND role != 'super_admin' RETURNING *",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable ou protégé" });
    }

    res.json({ message: "Utilisateur supprimé", user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   👑 SUPER ADMIN - APPROUVER / REJETER UPGRADE
====================================================== */

router.put("/upgrade/:userId/approve", authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users
       SET plan='Premium',
           upgrade_status='validé',
           payment_status='À jour'
       WHERE id=$1
       RETURNING id, username, plan, upgrade_status`,
      [req.params.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json({
      message: "Upgrade validé avec succès",
      user: result.rows[0]
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.put("/upgrade/:userId/reject", authenticateToken, isSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users
       SET plan='Free',
           upgrade_status='rejeté'
       WHERE id=$1
       RETURNING id, username, plan, upgrade_status`,
      [req.params.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    res.json({
      message: "Upgrade rejeté",
      user: result.rows[0]
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🔄 UPGRADE (OWNER)
====================================================== */

router.put("/upgrade", authenticateToken, async (req, res) => {
  if (req.user.type !== "owner") {
    return res.status(403).json({ error: "Seul le propriétaire peut faire un upgrade" });
  }

  const { phone, payment_method, amount, expiration } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users
       SET phone=$1,
           plan='Premium',
           payment_method=$2,
           amount=$3,
           expiration=$4,
           upgrade_status='en attente'
       WHERE id=$5
       RETURNING id, username, plan, upgrade_status`,
      [phone, payment_method, amount, expiration, req.user.id]
    );

    res.json({
      message: "Demande d’upgrade enregistrée",
      user: result.rows[0]
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
     LIMIT 1`,
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
      shop_id: user.shop_id,
      type: user.role === "super_admin" ? "super_admin" : "owner"
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  res.json({ token, user });
});

module.exports = router;
