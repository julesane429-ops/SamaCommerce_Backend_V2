const express = require("express");
const router = express.Router();
const db = require("../db");

const { verifyToken, requireRole } = require("../middleware/auth");
const checkSubscription = require("../middleware/subscription");


// ======================================================
// 🔔 GET ALERTS
// ======================================================
router.get(
  "/",
  verifyToken,
  checkSubscription,
  requireRole("owner", "employee"),
  async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT *
         FROM alerts
         WHERE archived = false
         AND shop_id = $1
         ORDER BY created_at DESC`,
        [req.user.shop_id]
      );

      res.json(rows);
    } catch (err) {
      console.error("Erreur GET /alerts:", err);
      res.status(500).json({ error: "Impossible de charger les alertes" });
    }
  }
);


// ======================================================
// 👁️ MARQUER VUE
// ======================================================
router.patch(
  "/:id/seen",
  verifyToken,
  checkSubscription,
  requireRole("owner", "employee"),
  async (req, res) => {
    try {
      const alertId = parseInt(req.params.id, 10);
      if (isNaN(alertId)) {
        return res.status(400).json({ error: "ID invalide" });
      }

      const { rows } = await db.query(
        `UPDATE alerts
         SET seen = true
         WHERE id = $1 AND shop_id = $2
         RETURNING *`,
        [alertId, req.user.shop_id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Alerte introuvable" });
      }

      res.json(rows[0]);
    } catch (err) {
      console.error("Erreur PATCH seen:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);


// ======================================================
// 🚫 IGNORER
// ======================================================
router.patch(
  "/:id/ignore",
  verifyToken,
  checkSubscription,
  requireRole("owner", "employee"),
  async (req, res) => {
    try {
      const alertId = parseInt(req.params.id, 10);
      if (isNaN(alertId)) {
        return res.status(400).json({ error: "ID invalide" });
      }

      const { rows } = await db.query(
        `UPDATE alerts
         SET ignored = true
         WHERE id = $1 AND shop_id = $2
         RETURNING *`,
        [alertId, req.user.shop_id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Alerte introuvable" });
      }

      res.json(rows[0]);
    } catch (err) {
      console.error("Erreur PATCH ignore:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);


// ======================================================
// 🗑 ARCHIVER
// ======================================================
router.delete(
  "/:id",
  verifyToken,
  checkSubscription,
  requireRole("owner"),
  async (req, res) => {
    try {
      const alertId = parseInt(req.params.id, 10);
      if (isNaN(alertId)) {
        return res.status(400).json({ error: "ID invalide" });
      }

      const { rowCount } = await db.query(
        `UPDATE alerts
         SET archived = true
         WHERE id = $1 AND shop_id = $2`,
        [alertId, req.user.shop_id]
      );

      if (rowCount === 0) {
        return res.status(404).json({ error: "Alerte introuvable" });
      }

      res.json({ message: "Alerte archivée" });
    } catch (err) {
      console.error("Erreur DELETE alert:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

module.exports = router;
