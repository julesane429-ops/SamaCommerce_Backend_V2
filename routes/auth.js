const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const sendEmail = require("../utils/mailer");


/* ======================================================
   🔐 MIDDLEWARE AUTH
====================================================== */

function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Token manquant" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Token invalide" });
  }
}


/* ======================================================
   🔒 MIDDLEWARE ROLES UNIVERSEL
====================================================== */

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: "Accès non autorisé"
      });
    }
    next();
  };
}


/* ======================================================
   📝 INSCRIPTION OWNER
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

    const userResult = await pool.query(
      `INSERT INTO users 
        (username, password, company_name, phone, role, plan, status)
       VALUES ($1,$2,$3,$4,'owner','Free','Actif')
       RETURNING *`,
      [username, hashedPassword, company_name || null, phone || null]
    );

    const user = userResult.rows[0];

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
   🔑 LOGIN (USERS + EMPLOYEES)
====================================================== */

router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  try {

    /* ================= USERS ================= */

    const userResult = await pool.query(
      `SELECT id, username, password, role,
              status, plan, shop_id
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

      const token = jwt.sign(
        {
          id: user.id,
          username: user.username,
          role: user.role,
          shop_id: user.shop_id,
          plan: user.plan
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
          shop_id: user.shop_id,
          plan: user.plan
        }
      });
    }

    /* ================= EMPLOYEES ================= */

    const empResult = await pool.query(
      `SELECT id, email, password, role, shop_id, is_active
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
        plan: null
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    return res.json({
      token,
      user: {
        id: employee.id,
        role: employee.role,
        shop_id: employee.shop_id
      }
    });

  } catch (err) {
    console.error("Erreur login:", err);
    res.status(500).json({ error: err.message });
  }
});


/* ======================================================
   👤 /ME
====================================================== */

router.get("/me", verifyToken, async (req, res) => {

  if (req.user.role === "employee") {
    const emp = await pool.query(
      "SELECT id, email, role, shop_id FROM employees WHERE id=$1",
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
   👑 SUPER ADMIN ONLY
====================================================== */

router.get(
  "/users",
  verifyToken,
  requireRole("super_admin"),
  async (req, res) => {
    const result = await pool.query(
      "SELECT id, username, role, plan, status FROM users ORDER BY id DESC"
    );
    res.json(result.rows);
  }
);

module.exports = {
  router,
  verifyToken,
  requireRole
};
