// routes/boutiques.js — Gestion multi-boutiques
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const verifyToken = require('../middleware/auth');
const requirePlan = require('../middleware/checkSubscription');
const { getBoutiquesLimit } = require('../middleware/planConfig');
const { invalidate } = require('../middleware/boutiqueContext');

// ── GET /boutiques ── Lister ses boutiques
router.get('/', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.*, 
        (SELECT COUNT(*) FROM products WHERE boutique_id = b.id)::int AS nb_produits,
        (SELECT COUNT(*) FROM sales    WHERE boutique_id = b.id)::int AS nb_ventes
       FROM boutiques b
       WHERE b.owner_id = $1
       ORDER BY b.is_primary DESC, b.created_at ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /boutiques:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /boutiques ── Créer une nouvelle boutique (Enterprise uniquement)
router.post('/', verifyToken, requirePlan('multi_boutique'), async (req, res) => {
  const { name, phone, address, emoji } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Le nom est requis' });

  try {
    // Vérifier la limite du plan
    const planRow = await db.query(
      'SELECT plan, upgrade_status FROM users WHERE id = $1',
      [req.user.id]
    );
    const plan  = planRow.rows[0]?.plan || 'Free';
    const limit = getBoutiquesLimit(plan);

    const countRow = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM boutiques WHERE owner_id = $1',
      [req.user.id]
    );
    if (countRow.rows[0].cnt >= limit) {
      return res.status(400).json({
        error:   `Limite atteinte`,
        code:    'BOUTIQUE_LIMIT_REACHED',
        limit,
        message: `Le plan ${plan} permet au maximum ${limit} boutique${limit > 1 ? 's' : ''}.`,
      });
    }

    const { rows } = await db.query(
      `INSERT INTO boutiques (owner_id, name, phone, address, emoji, is_primary)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING *`,
      [req.user.id, name.trim(), phone || null, address || null, emoji || '🏪']
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /boutiques:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /boutiques/:id ── Modifier une boutique
router.patch('/:id', verifyToken, async (req, res) => {
  const { name, phone, address, emoji } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE boutiques SET
         name    = COALESCE($1, name),
         phone   = COALESCE($2, phone),
         address = COALESCE($3, address),
         emoji   = COALESCE($4, emoji),
         updated_at = NOW()
       WHERE id = $5 AND owner_id = $6
       RETURNING *`,
      [name || null, phone || null, address || null, emoji || null,
       req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Boutique introuvable' });

    // Invalider le cache
    invalidate(req.user.id);

    // Sync le company_name si boutique primaire
    if (rows[0].is_primary && name) {
      await db.query(
        'UPDATE users SET company_name = $1 WHERE id = $2',
        [name, req.user.id]
      );
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /boutiques/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /boutiques/:id ── Supprimer une boutique (pas la primaire)
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM boutiques WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Boutique introuvable' });
    if (rows[0].is_primary) {
      return res.status(400).json({ error: 'Impossible de supprimer la boutique principale' });
    }

    await db.query('DELETE FROM boutiques WHERE id = $1', [req.params.id]);
    invalidate(req.user.id);
    res.json({ message: 'Boutique supprimée' });
  } catch (err) {
    console.error('DELETE /boutiques/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /boutiques/:id/stats ── Statistiques d'une boutique
router.get('/:id/stats', verifyToken, async (req, res) => {
  try {
    const boutiqueId = parseInt(req.params.id);

    // Vérifier l'appartenance
    const own = await db.query(
      'SELECT id FROM boutiques WHERE id = $1 AND owner_id = $2',
      [boutiqueId, req.user.id]
    );
    if (!own.rows.length) return res.status(403).json({ error: 'Accès refusé' });

    const [produits, ventes, ca] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS cnt FROM products WHERE boutique_id = $1', [boutiqueId]),
      db.query('SELECT COUNT(*)::int AS cnt FROM sales WHERE boutique_id = $1', [boutiqueId]),
      db.query('SELECT COALESCE(SUM(total),0)::numeric AS total FROM sales WHERE boutique_id = $1 AND paid = true', [boutiqueId]),
    ]);

    res.json({
      boutique_id:  boutiqueId,
      nb_produits:  produits.rows[0].cnt,
      nb_ventes:    ventes.rows[0].cnt,
      ca_total:     parseFloat(ca.rows[0].total),
    });
  } catch (err) {
    console.error('GET /boutiques/:id/stats:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
