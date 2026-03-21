// routes/members.js — Gestion multi-appareil / équipe boutique
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const verifyToken = require('../middleware/auth');
const crypto     = require('crypto');
const employeeProxy = require('../middleware/employeeProxy');

const INVITE_TTL_HOURS = 72;

// Permissions disponibles
const ALL_PERMS = ['vente', 'stock', 'rapports', 'credits', 'clients',
                   'fournisseurs', 'commandes', 'livraisons'];

// ── GET /members ── Liste des membres de ma boutique
router.get('/', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT bm.id, bm.email, bm.role, bm.status, bm.permissions,
             bm.created_at, bm.accepted_at,
             u.company_name, u.phone
      FROM boutique_members bm
      LEFT JOIN users u ON bm.member_id = u.id
      WHERE bm.boutique_id = $1
      ORDER BY bm.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('GET /members:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /members/invite ── Inviter un employé
router.post('/invite', verifyToken, async (req, res) => {
  const { email, role = 'employe', permissions } = req.body;

  if (!email) return res.status(400).json({ error: 'Email requis' });

  try {
    // Vérifier quota (max 3 membres par boutique)
    const { rows: existing } = await db.query(
      "SELECT COUNT(*)::int AS cnt FROM boutique_members WHERE boutique_id = $1 AND status != 'rejected'",
      [req.user.id]
    );
    if (existing[0].cnt >= 3) {
      return res.status(400).json({ error: 'Maximum 3 membres par boutique' });
    }

    // Vérifier si déjà invité
    const dup = await db.query(
      "SELECT id FROM boutique_members WHERE boutique_id = $1 AND email = $2",
      [req.user.id, email]
    );
    if (dup.rows.length) {
      return res.status(400).json({ error: 'Cet email est déjà invité' });
    }

    // Permissions par défaut selon le rôle
    const defaultPerms = role === 'gerant'
      ? { vente:true, stock:true, rapports:true, credits:true, clients:true, fournisseurs:true, commandes:true, livraisons:true }
      : { vente:true, stock:false, rapports:false, credits:false, clients:false, fournisseurs:false, commandes:false, livraisons:false };

    const finalPerms = permissions || defaultPerms;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);

    const { rows } = await db.query(`
      INSERT INTO boutique_members
        (boutique_id, email, role, status, permissions, invite_token, invite_expires_at)
      VALUES ($1, $2, $3, 'pending', $4, $5, $6)
      RETURNING *
    `, [req.user.id, email, role, finalPerms, token, expiresAt]);

    // TODO: envoyer un email d'invitation (optionnel)
    // await sendEmail(email, 'Invitation boutique', `Rejoignez la boutique sur Sama Commerce : ${token}`);

    res.status(201).json({
      message: 'Invitation envoyée',
      member: rows[0],
      invite_link: `${req.headers.origin || 'https://samacommerce-frontend-v2-1.onrender.com'}/login/login.html?invite=${token}`,
    });
  } catch (err) {
    console.error('POST /members/invite:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /members/accept ── Accepter une invitation
router.post('/accept', verifyToken, async (req, res) => {
  const { invite_token } = req.body;
  if (!invite_token) return res.status(400).json({ error: 'Token requis' });

  try {
    const { rows } = await db.query(
      "SELECT * FROM boutique_members WHERE invite_token = $1 AND status = 'pending'",
      [invite_token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invitation invalide ou expirée' });

    const invite = rows[0];

    // Vérifier l'expiration
    if (invite.invite_expires_at && new Date(invite.invite_expires_at) < new Date()) {
      await db.query(
        "UPDATE boutique_members SET status='rejected' WHERE id=$1",
        [invite.id]
      );
      return res.status(410).json({ error: 'Cette invitation a expiré. Demandez une nouvelle invitation.' });
    }

    // Mettre à jour le membre
    await db.query(`
      UPDATE boutique_members
      SET status = 'accepted', member_id = $1, accepted_at = NOW(), invite_token = NULL
      WHERE id = $2
    `, [req.user.id, invite.id]);

    // Récupérer les infos de la boutique principale
    const { rows: boutique } = await db.query(
      'SELECT id, company_name, username FROM users WHERE id = $1',
      [invite.boutique_id]
    );

    res.json({
      message: 'Invitation acceptée',
      boutique: boutique[0],
      permissions: invite.permissions,
      role: invite.role,
    });
  } catch (err) {
    console.error('POST /members/accept:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /members/:id ── Modifier permissions d'un membre
router.patch('/:id', verifyToken, async (req, res) => {
  const { permissions, role } = req.body;

  try {
    const { rows } = await db.query(`
      UPDATE boutique_members
      SET permissions = COALESCE($1, permissions),
          role        = COALESCE($2, role)
      WHERE id = $3 AND boutique_id = $4
      RETURNING *
    `, [permissions ? JSON.stringify(permissions) : null, role || null,
        req.params.id, req.user.id]);

    if (!rows.length) return res.status(404).json({ error: 'Membre introuvable' });

    // Invalider le cache du proxy pour que les nouvelles permissions soient actives immédiatement
    if (rows[0].member_id) employeeProxy.invalidate(rows[0].member_id);

    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /members/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /members/:id ── Retirer un membre
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM boutique_members WHERE id = $1 AND boutique_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Membre introuvable' });

    // Invalider le cache proxy
    const { rows: deleted } = await db.query(
      'SELECT member_id FROM boutique_members WHERE id=$1', [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (deleted[0]?.member_id) employeeProxy.invalidate(deleted[0].member_id);

    res.json({ message: 'Membre retiré' });
  } catch (err) {
    console.error('DELETE /members/:id:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /members/my-boutique ── Infos de la boutique principale (pour un employé)
router.get('/my-boutique', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT bm.permissions, bm.role,
             u.id AS boutique_id, u.company_name, u.username AS boutique_email
      FROM boutique_members bm
      JOIN users u ON bm.boutique_id = u.id
      WHERE bm.member_id = $1 AND bm.status = 'accepted'
      LIMIT 1
    `, [req.user.id]);

    if (!rows.length) return res.json(null);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /members/my-boutique:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
