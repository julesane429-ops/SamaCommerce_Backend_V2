const express = require("express");
const router = express.Router();
const pool = require("../db");
const verifyToken = require("../middleware/auth");


// ======================================================
// 🔔 GET ALERTS (par boutique)
// ======================================================
router.get("/", verifyToken, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT *
       FROM alerts
       WHERE archived = false
       AND shop_id = $1
       ORDER BY created_at DESC`,
      [req.user.shop_id]
    );

    res.json(q.rows);

  } catch (err) {
    console.error("Erreur GET /alerts:", err);
    res.status(500).json({ error: "Impossible de charger les alertes" });
  }
});


// ======================================================
// 👁️ MARQUER VUE
// ======================================================
router.patch("/:id/seen", verifyToken, async (req, res) => {
  try {
    const q = await pool.query(
      `UPDATE alerts
       SET seen = true
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [req.params.id, req.user.shop_id]
    );

    if (q.rowCount === 0) {
      return res.status(404).json({ error: "Alerte introuvable" });
    }

    res.json(q.rows[0]);

  } catch (err) {
    console.error("Erreur PATCH seen:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// 🚫 IGNORER
// ======================================================
router.patch("/:id/ignore", verifyToken, async (req, res) => {
  try {
    const q = await pool.query(
      `UPDATE alerts
       SET ignored = true
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [req.params.id, req.user.shop_id]
    );

    if (q.rowCount === 0) {
      return res.status(404).json({ error: "Alerte introuvable" });
    }

    res.json(q.rows[0]);

  } catch (err) {
    console.error("Erreur PATCH ignore:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


// ======================================================
// 🗑 ARCHIVER
// ======================================================
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const q = await pool.query(
      `UPDATE alerts
       SET archived = true
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [req.params.id, req.user.shop_id]
    );

    if (q.rowCount === 0) {
      return res.status(404).json({ error: "Alerte introuvable" });
    }

    res.json({ message: "Alerte archivée" });

  } catch (err) {
    console.error("Erreur DELETE alert:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
