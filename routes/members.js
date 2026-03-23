// routes/members.js — Gestion multi-appareil / équipe boutique
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const verifyToken = require('../middleware/auth');
const crypto     = require('crypto');
const employeeProxy          = require('../middleware/employeeProxy');
const { getMembersLimit } = require('../middleware/planConfig');

const INVITE_TTL_HOURS = 72;

// Permissions disponibles
const ALL_PERMS = ['vente', 'stock', 'categories', 'rapports', 'caisse', 'credits', 'clients',
                   'fournisseurs', 'commandes', 'livraisons'];

// ── GET /members ── Liste des membres
// ?boutique_id=X : filtre par boutique (owner ou employé de cette boutique)
// sans paramètre   : tous les membres dont l'owner_user_id = moi
router.get('/', verifyToken, async (req, res) => {
  try {
    const boutiqueId = req.query.boutique_id ? parseInt(req.query.boutique_id) : null;

    if (boutiqueId) {
      // 1. Vérifier que l'utilisateur est OWNER de cette boutique
      const { rows: owned } = await db.query(
        'SELECT id FROM boutiques WHERE id = $1 AND owner_id = $2',
        [boutiqueId, req.user.id]
      );

      // 2. Sinon vérifier que c'est un EMPLOYÉ accepté de cette boutique
      if (!owned.length) {
        const { rows: memberOf } = await db.query(
          `SELECT id FROM boutique_members
           WHERE ref_boutique_id = $1 AND member_id = $2 AND status = 'accepted'`,
          [boutiqueId, req.user.id]
        );
        if (!memberOf.length) {
          return res.status(403).json({ error: 'Accès refusé' });
        }
      }

      // Retourner les membres de cette boutique
      const { rows } = await db.query(`
        SELECT bm.id, bm.email, bm.role, bm.status, bm.permissions,
               bm.created_at, bm.accepted_at,
               u.company_name, u.phone
        FROM boutique_members bm
        LEFT JOIN users u ON bm.member_id = u.id
        WHERE bm.ref_boutique_id = $1
        ORDER BY bm.created_at DESC
      `, [boutiqueId]);
      return res.json(rows);
    }

    // Sans filtre boutique → tous les membres de toutes les boutiques de cet owner
    const { rows } = await db.query(`
      SELECT bm.id, bm.email, bm.role, bm.status, bm.permissions,
             bm.created_at, bm.accepted_at,
             u.company_name, u.phone
      FROM boutique_members bm
      LEFT JOIN users u ON bm.member_id = u.id
      WHERE bm.owner_user_id = $1
      ORDER BY bm.created_at DESC
    `, [req.user.id]);
    res.json(rows);

  } catch (err) {
    console.error('GET /members:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /members/invite ── Inviter un employé
router.post('/invite', verifyToken, async (req, res) => {
  const { email, role = 'employe', permissions } = req.body;

  if (!email) return res.status(400).json({ error: 'Email requis' });

  try {
    // Quota membres selon le plan de la boutique
    const planRow = await db.query('SELECT plan, upgrade_status FROM users WHERE id = $1', [req.user.id]);
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

    const { rows: existing } = await db.query(
      "SELECT COUNT(*)::int AS cnt FROM boutique_members WHERE boutique_id = $1 AND status != 'rejected'",
      [req.user.id]
    );
    if (existing[0].cnt >= membLimit) {
      return res.status(400).json({
        error:   `Maximum ${membLimit} membre${membLimit > 1 ? 's' : ''} pour le plan ${planName}`,
        code:    'MEMBER_LIMIT_REACHED',
        limit:   membLimit,
      });
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
      ? { vente:true, stock:true, categories:true, rapports:true, caisse:true, credits:true, clients:true, fournisseurs:true, commandes:true, livraisons:true }
      : { vente:true, stock:false, categories:false, rapports:false, caisse:false, credits:false, clients:false, fournisseurs:false, commandes:false, livraisons:false };

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
    console.error('POST /members/invite:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /members/accept ── Accepter une invitation
router.post('/accept', verifyToken, async (req, res) => {
  const { invite_token } = req.body;
  if (!invite_token) return res.status(400).json({ error: 'Token requis' });

  try {
    // Chercher d'abord une invitation pending avec ce token
    const { rows } = await db.query(
      "SELECT * FROM boutique_members WHERE invite_token = $1 AND status = 'pending'",
      [invite_token]
    );

    // Si pas trouvée en pending, vérifier si elle a déjà été acceptée par cet utilisateur
    if (!rows.length) {
      const memberId = req.user.realId || req.user.id;
      const { rows: alreadyAccepted } = await db.query(
        `SELECT bm.*, u.company_name, u.username AS boutique_email
         FROM boutique_members bm
         JOIN users u ON bm.boutique_id = u.id
         WHERE bm.member_id = $1 AND bm.status = 'accepted'
         LIMIT 1`,
        [memberId]
      );
      if (alreadyAccepted.length) {
        // Déjà membre → renvoyer les infos de la boutique comme si c'était un succès
        return res.json({
          message: 'Vous êtes déjà membre de cette boutique',
          already_member: true,
          boutique: { id: alreadyAccepted[0].boutique_id, company_name: alreadyAccepted[0].company_name },
          role: alreadyAccepted[0].role,
          permissions: alreadyAccepted[0].permissions,
        });
      }
      return res.status(404).json({ error: 'Invitation invalide ou expirée' });
    }

    const invite = rows[0];

    // Vérifier l'expiration
    if (invite.invite_expires_at && new Date(invite.invite_expires_at) < new Date()) {
      await db.query(
        "UPDATE boutique_members SET status='rejected' WHERE id=$1",
        [invite.id]
      );
      return res.status(410).json({ error: 'Cette invitation a expiré. Demandez une nouvelle invitation.' });
    }

    // Mettre à jour le membre — utiliser realId si proxy actif
    const memberId = req.user.realId || req.user.id;
    await db.query(`
      UPDATE boutique_members
      SET status = 'accepted', member_id = $1, accepted_at = NOW(), invite_token = NULL
      WHERE id = $2
    `, [memberId, invite.id]);

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
      WHERE id = $3 AND boutique_id = $4
      RETURNING *
    `, [permissions || null, role || null,
        req.params.id, req.user.id]);

    if (!rows.length) return res.status(404).json({ error: 'Membre introuvable' });

    // Invalider le cache du proxy pour que les nouvelles permissions soient actives immédiatement
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
    // Récupérer member_id AVANT la suppression pour invalider le cache proxy
    const { rows: existing } = await db.query(
      'SELECT id, member_id, boutique_id FROM boutique_members WHERE id = $1',
      [req.params.id]
    );

    if (!existing.length) {
      return res.status(404).json({ error: 'Membre introuvable' });
    }

    // Vérifier que ce membre appartient bien à cette boutique
    if (String(existing[0].boutique_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Supprimer
    await db.query(
      'DELETE FROM boutique_members WHERE id = $1',
      [req.params.id]
    );

    // Invalider le cache proxy si l'employé était connecté
    if (existing[0].member_id) {
      employeeProxy.invalidate(existing[0].member_id);
    }

    res.json({ message: 'Membre retiré' });
  } catch (err) {
    console.error('DELETE /members/:id:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /members/my-boutique ── Infos de la boutique principale (pour un employé)
router.get('/my-boutique', verifyToken, async (req, res) => {
  try {
    // Utiliser realId si le proxy a déjà remplacé req.user.id
    const memberId = req.user.realId || req.user.id;

    const { rows } = await db.query(`
      SELECT bm.permissions, bm.role,
             u.id AS boutique_id, u.company_name, u.username AS boutique_email
      FROM boutique_members bm
      JOIN users u ON bm.boutique_id = u.id
      WHERE bm.member_id = $1 AND bm.status = 'accepted'
      LIMIT 1
    `, [memberId]);

    if (!rows.length) return res.json(null);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /members/my-boutique:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ── POST /members/:id/resend ── Rengénérer un lien d'invitation expiré
router.post('/:id/resend', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM boutique_members WHERE id = $1 AND boutique_id = $2 AND status = 'pending'",
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Membre introuvable ou déjà accepté' });

    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);

    await db.query(
      `UPDATE boutique_members
       SET invite_token = $1, invite_expires_at = $2
       WHERE id = $3 AND boutique_id = $4`,
      [token, expiresAt, req.params.id, req.user.id]
    );

    const link = `${req.headers.origin || 'https://samacommerce-frontend-v2-1.onrender.com'}/login/login.html?invite=${token}&email=${encodeURIComponent(rows[0].email)}`;

    res.json({
      message: 'Lien renvoyé',
      invite_link: link,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('POST /members/:id/resend:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
