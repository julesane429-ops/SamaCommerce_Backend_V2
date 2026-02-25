const express = require("express");
const router = express.Router();
const pool = require("../db");
const verifyToken = require("../middleware/auth");

/**
 * ✅ GET /alerts
 * Charger les alertes du shop uniquement
 */
router.get("/", verifyToken, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT a.*, u.username
       FROM alerts a
       LEFT JOIN users u ON a.user_id = u.id
       WHERE a.archived = false
       AND a.shop_id = $1
       ORDER BY a.created_at DESC`,
      [req.user.shop_id]
    );

    res.json(q.rows);
  } catch (err) {
    console.error("❌ Erreur GET /alerts:", err);
    res.status(500).json({ error: "Impossible de charger les alertes" });
  }
});

/**
 * ✅ PATCH /alerts/:id/seen
 * Marquer comme vue (sécurisé shop)
 */
router.patch("/:id/seen", verifyToken, async (req, res) => {
  try {
    const q = await pool.query(
      `UPDATE alerts 
       SET seen = true 
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [req.params.id, req.user.shop_id]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ error: "Alerte introuvable ou non autorisée" });
    }

    res.json({ message: "✅ Alerte marquée comme vue", alert: q.rows[0] });
  } catch (err) {
    console.error("❌ Erreur PATCH /alerts/:id/seen:", err);
    res.status(500).json({ error: "Impossible de mettre à jour l’alerte" });
  }
});

/**
 * ✅ PATCH /alerts/:id/ignore
 * Ignorer (sécurisé shop)
 */
router.patch("/:id/ignore", verifyToken, async (req, res) => {
  try {
    const q = await pool.query(
      `UPDATE alerts 
       SET ignored = true 
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [req.params.id, req.user.shop_id]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ error: "Alerte introuvable ou non autorisée" });
    }

    res.json({ message: "✅ Alerte ignorée", alert: q.rows[0] });
  } catch (err) {
    console.error("❌ Erreur PATCH /alerts/:id/ignore:", err);
    res.status(500).json({ error: "Impossible d’ignorer l’alerte" });
  }
});

/**
 * ✅ DELETE /alerts/:id
 * Archiver (sécurisé shop)
 */
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const q = await pool.query(
      `UPDATE alerts 
       SET archived = true 
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [req.params.id, req.user.shop_id]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ error: "Alerte introuvable ou non autorisée" });
    }

    res.json({ message: "✅ Alerte fermée", alert: q.rows[0] });
  } catch (err) {
    console.error("❌ Erreur DELETE /alerts/:id:", err);
    res.status(500).json({ error: "Impossible de fermer l’alerte" });
  }
});

module.exports = router;
