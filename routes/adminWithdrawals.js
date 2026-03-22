const express = require("express");
const router = express.Router();
const db = require("../db");
const verifyToken = require("../middleware/auth");

// Middleware admin
function isAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Accès réservé aux administrateurs" });
  }
  next();
}

// 🔹 Créer une demande de retrait
router.post("/", verifyToken, isAdmin, async (req, res) => {
  const { amount, method } = req.body;
  if (!amount || !method) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  try {
    const q = await db.query(
      `INSERT INTO withdrawals (admin_id, amount, method, status) 
       VALUES ($1,$2,$3,'en attente')
       RETURNING *`,
      [req.user.id, amount, method]
    );

    res.json({ message: "Demande de retrait enregistrée", withdrawal: q.rows[0] });
  } catch (err) {
    console.error("❌ Erreur retrait:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Historique des retraits
router.get("/", verifyToken, isAdmin, async (req, res) => {
  try {
    const q = await db.query(
      `SELECT * FROM withdrawals 
       WHERE admin_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(q.rows);
  } catch (err) {
    console.error("❌ Erreur liste retraits:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
