// routes/members.js — Gestion équipe multi-boutiques
// ──────────────────────────────────────────────────────────────────────
// CHANGEMENTS vs version précédente :
//   - Les invitations utilisent ref_boutique_id (boutiques.id) au lieu
//     de boutique_id (users.id) pour pointer vers la bonne boutique
//   - POST /invite accepte un param boutique_id (de la table boutiques)
//   - GET /  liste les membres par boutique_id (optionnel)
//   - GET /my-boutique retourne la boutique précise de l'employé
// ──────────────────────────────────────────────────────────────────────

const express     = require('express');
const router      = express.Router();
const db          = require('../db');
const verifyToken = require('../middleware/auth');
const crypto      = require('crypto');
const employeeProxy          = require('../middleware/employeeProxy');
const { getMembersLimit }    = require('../middleware/planConfig');

const INVITE_TTL_HOURS = 72;

// ── GET /members ── Liste des membres (tous, ou filtrés par boutique)
// Query param optionnel : ?boutique_id=X (boutiques.id)
router.get('/', verifyToken, async (req, res) => {
  try {
    // Si boutique_id fourni, filtrer sur ref_boutique_id
    const boutiqueId = req.query.boutique_id ? parseInt(req.query.boutique_id) : null;

    let query, params;

    if (boutiqueId) {
      // Vérifier que l'owner possède bien cette boutique
      const own = await db.query(
        'SELECT id FROM boutiques WHERE id = $1 AND owner_id = $2',
        [boutiqueId, req.user.id]
      );
      if (!own.rows.length) return res.status(403).json({ error: 'Accès refusé' });

      query = `
        SELECT bm.id, bm.email, bm.role, bm.status, bm.permissions,
               bm.created_at, bm.accepted_at, bm.invite_expires_at,
               bm.ref_boutique_id,
               u.company_name, u.phone,
               b.name AS boutique_name, b.emoji AS boutique_emoji
        FROM boutique_members bm
        LEFT JOIN users u     ON bm.member_id = u.id
        LEFT JOIN boutiques b ON bm.ref_boutique_id = b.id
        WHERE bm.ref_boutique_id = $1
        ORDER BY bm.created_at DESC
      `;
      params = [boutiqueId];
    } else {
      // Tous les membres de toutes les boutiques de l'owner
      query = `
        SELECT bm.id, bm.email, bm.role, bm.status, bm.permissions,
               bm.created_at, bm.accepted_at, bm.invite_expires_at,
               bm.ref_boutique_id,
               u.company_name, u.phone,
               b.name AS boutique_name, b.emoji AS boutique_emoji
        FROM boutique_members bm
        LEFT JOIN users u     ON bm.member_id = u.id
        LEFT JOIN boutiques b ON bm.ref_boutique_id = b.id
        WHERE bm.owner_user_id = $1
        ORDER BY bm.ref_boutique_id, bm.created_at DESC
      `;
      params = [req.user.id];
    }

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /members:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /members/invite ── Inviter un employé dans une boutique précise
router.post('/invite', verifyToken, async (req, res) => {
  const { email, role = 'employe', permissions, boutique_id } = req.body;

  if (!email) return res.status(400).json({ error: 'Email requis' });
  if (!boutique_id) return res.status(400).json({ error: 'boutique_id requis — spécifiez dans quelle boutique inviter' });

  try {
    // ── 1. Vérifier que l'owner possède la boutique cible
    const boutRow = await db.query(
      'SELECT * FROM boutiques WHERE id = $1 AND owner_id = $2',
      [boutique_id, req.user.id]
    );
    if (!boutRow.rows.length) {
      return res.status(403).json({ error: 'Boutique introuvable ou accès refusé' });
    }
    const boutique = boutRow.rows[0];

    // ── 2. Quota membres selon le plan
    const planRow   = await db.query('SELECT plan, upgrade_status FROM users WHERE id = $1', [req.user.id]);
    const planName  = planRow.rows[0]?.plan || 'Free';
    const isActive  = planRow.rows[0]?.upgrade_status === 'validé';
    const membLimit = getMembersLimit(isActive ? planName : 'Free');

    if (membLimit === 0) {
      return res.status(402).json({
        error:            'Plan insuffisant',
        code:             'PLAN_INSUFFICIENT',
        message:          `Le plan ${planName} ne permet pas d'inviter des employés. Passez au plan Business.`,
        upgrade_required: true,
      });
    }

    // ── 3. Compter les membres actifs de TOUTES les boutiques de l'owner (quota global)
    if (membLimit !== Infinity) {
      const { rows: existing } = await db.query(
        "SELECT COUNT(*)::int AS cnt FROM boutique_members WHERE owner_user_id = $1 AND status != 'rejected'",
        [req.user.id]
      );
      if (existing[0].cnt >= membLimit) {
        return res.status(400).json({
          error: `Maximum ${membLimit} membre${membLimit > 1 ? 's' : ''} pour le plan ${planName}`,
          code:  'MEMBER_LIMIT_REACHED',
          limit: membLimit,
        });
      }
    }

    // ── 4. Vérifier doublon dans cette boutique
    const dup = await db.query(
      "SELECT id FROM boutique_members WHERE ref_boutique_id = $1 AND email = $2",
      [boutique_id, email]
    );
    if (dup.rows.length) {
      return res.status(400).json({ error: 'Cet email est déjà invité dans cette boutique' });
    }

    // ── 5. Permissions par défaut selon le rôle
    const defaultPerms = role === 'gerant'
      ? { vente:true, stock:true, categories:true, rapports:true, caisse:true,
          credits:true, clients:true, fournisseurs:true, commandes:true, livraisons:true }
      : { vente:true, stock:false, categories:false, rapports:false, caisse:false,
          credits:false, clients:false, fournisseurs:false, commandes:false, livraisons:false };

    const finalPerms = permissions || defaultPerms;
    const token      = crypto.randomBytes(32).toString('hex');
    const expiresAt  = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);

    // ── 6. Insérer avec ref_boutique_id et owner_user_id
    const { rows } = await db.query(`
      INSERT INTO boutique_members
        (boutique_id, owner_user_id, ref_boutique_id, email, role, status, permissions, invite_token, invite_expires_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
      RETURNING *
    `, [req.user.id, req.user.id, boutique_id, email, role, finalPerms, token, expiresAt]);

    const origin    = req.headers.origin || 'https://samacommerce-frontend-v2-1.onrender.com';
    const inviteUrl = `${origin}/login/login.html?invite=${token}&email=${encodeURIComponent(email)}`;

    res.status(201).json({
      message:     'Invitation envoyée',
      member:      rows[0],
      boutique:    { id: boutique.id, name: boutique.name, emoji: boutique.emoji },
      invite_link: inviteUrl,
    });
  } catch (err) {
    console.error('POST /members/invite:', err.message);
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

    if (!rows.length) {
      const memberId = req.user.realId || req.user.id;
      const { rows: already } = await db.query(
        `SELECT bm.*, b.name AS boutique_name, b.emoji AS boutique_emoji
         FROM boutique_members bm
         LEFT JOIN boutiques b ON bm.ref_boutique_id = b.id
         WHERE bm.member_id = $1 AND bm.status = 'accepted'
         LIMIT 1`,
        [memberId]
      );
      if (already.length) {
        return res.json({
          message:       'Vous êtes déjà membre de cette boutique',
          already_member: true,
          boutique: {
            id:    already[0].ref_boutique_id,
            name:  already[0].boutique_name,
            emoji: already[0].boutique_emoji,
          },
          role:        already[0].role,
          permissions: already[0].permissions,
        });
      }
      return res.status(404).json({ error: 'Invitation invalide ou expirée' });
    }

    const invite = rows[0];

    if (invite.invite_expires_at && new Date(invite.invite_expires_at) < new Date()) {
      await db.query("UPDATE boutique_members SET status='rejected' WHERE id=$1", [invite.id]);
      return res.status(410).json({ error: 'Cette invitation a expiré. Demandez une nouvelle invitation.' });
    }

    const memberId = req.user.realId || req.user.id;
    await db.query(`
      UPDATE boutique_members
      SET status = 'accepted', member_id = $1, accepted_at = NOW(), invite_token = NULL
      WHERE id = $2
    `, [memberId, invite.id]);

    // Récupérer les infos de la boutique précise (ref_boutique_id)
    const { rows: boutique } = await db.query(
      'SELECT id, name, emoji, owner_id FROM boutiques WHERE id = $1',
      [invite.ref_boutique_id]
    );

    res.json({
      message:     'Invitation acceptée',
      boutique:    boutique[0] || { id: invite.ref_boutique_id },
      permissions: invite.permissions,
      role:        invite.role,
    });
  } catch (err) {
    console.error('POST /members/accept:', err.message);
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
      WHERE id = $3 AND owner_user_id = $4
      RETURNING *
    `, [permissions || null, role || null, req.params.id, req.user.id]);

    if (!rows.length) return res.status(404).json({ error: 'Membre introuvable' });

    if (rows[0].member_id) employeeProxy.invalidate(rows[0].member_id);

    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /members/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /members/:id ── Retirer un membre
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { rows: existing } = await db.query(
      'SELECT id, member_id, owner_user_id FROM boutique_members WHERE id = $1',
      [req.params.id]
    );

    if (!existing.length) return res.status(404).json({ error: 'Membre introuvable' });

    if (String(existing[0].owner_user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    await db.query('DELETE FROM boutique_members WHERE id = $1', [req.params.id]);

    if (existing[0].member_id) employeeProxy.invalidate(existing[0].member_id);

    res.json({ message: 'Membre retiré' });
  } catch (err) {
    console.error('DELETE /members/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /members/my-boutique ── Infos de la boutique de l'employé
router.get('/my-boutique', verifyToken, async (req, res) => {
  try {
    const memberId = req.user.realId || req.user.id;

    const { rows } = await db.query(`
      SELECT
        bm.permissions, bm.role,
        bm.ref_boutique_id AS boutique_id,
        b.name  AS boutique_name,
        b.emoji AS boutique_emoji,
        b.phone AS boutique_phone,
        u.id    AS owner_id,
        u.company_name,
        u.username AS boutique_email
      FROM boutique_members bm
      JOIN boutiques b ON bm.ref_boutique_id = b.id
      JOIN users u     ON b.owner_id = u.id
      WHERE bm.member_id = $1 AND bm.status = 'accepted'
      ORDER BY bm.accepted_at DESC
      LIMIT 1
    `, [memberId]);

    if (!rows.length) return res.json(null);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /members/my-boutique:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /members/:id/resend ── Renvoyer lien d'invitation
router.post('/:id/resend', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM boutique_members WHERE id = $1 AND owner_user_id = $2 AND status = 'pending'",
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Membre introuvable ou déjà accepté' });

    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);

    await db.query(
      `UPDATE boutique_members SET invite_token = $1, invite_expires_at = $2 WHERE id = $3`,
      [token, expiresAt, req.params.id]
    );

    const origin = req.headers.origin || 'https://samacommerce-frontend-v2-1.onrender.com';
    const link   = `${origin}/login/login.html?invite=${token}&email=${encodeURIComponent(rows[0].email)}`;

    res.json({ message: 'Lien renvoyé', invite_link: link, expires_at: expiresAt });
  } catch (err) {
    console.error('POST /members/:id/resend:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
