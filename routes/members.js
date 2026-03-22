// routes/members.js — Gestion multi-appareil / équipe boutique
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const verifyToken = require('../middleware/auth');
const crypto     = require('crypto');
const employeeProxy          = require('../middleware/employeeProxy');
const { getMembersLimit }    = require('../middleware/planConfig');

const INVITE_TTL_HOURS = 72;

const ALL_PERMS = [
  'vente', 'stock', 'categories', 'rapports', 'caisse',
  'credits', 'clients', 'fournisseurs', 'commandes', 'livraisons'
];

// ── GET /members ── Liste des membres d'une boutique ──────────────
// Si ?boutique_id=<id> → membres de cette boutique spécifique
// Sinon → membres de la boutique primaire (ou de req.user.id)
router.get('/', verifyToken, async (req, res) => {
  try {
    // Déterminer la boutique cible
    const boutiqueParam = parseInt(req.query.boutique_id || '0');
    let targetBoutiqueId = boutiqueParam || req.user.boutique_id || null;

    // Si pas de boutique_id, fallback sur l'ancienne logique (boutique_id = user_id)
    const whereClause = targetBoutiqueId
      ? `WHERE (bm.ref_boutique_id = $1 OR (bm.ref_boutique_id IS NULL AND bm.boutique_id = $1))`
      : `WHERE bm.boutique_id = $1`;
    const param = targetBoutiqueId || req.user.id;

    const { rows } = await db.query(`
      SELECT bm.id, bm.email, bm.role, bm.status, bm.permissions,
             bm.created_at, bm.accepted_at, bm.ref_boutique_id,
             u.company_name, u.phone,
             b.name AS boutique_name, b.emoji AS boutique_emoji
      FROM boutique_members bm
      LEFT JOIN users u     ON bm.member_id = u.id
      LEFT JOIN boutiques b ON bm.ref_boutique_id = b.id
      ${whereClause}
      ORDER BY bm.created_at DESC
    `, [param]);
    res.json(rows);
  } catch (err) {
    console.error('GET /members:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /members/invite ── Inviter un employé dans une boutique ──
// ✅ Nouveau paramètre optionnel : boutique_id (id depuis table boutiques)
//    Si absent → invite dans la boutique active (X-Boutique-Id ou primaire)
router.post('/invite', verifyToken, async (req, res) => {
  const { email, role = 'employe', permissions, boutique_id: reqBoutiqueId } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  try {
    // ── Vérifier le plan et les quotas ──
    const planRow = await db.query(
      'SELECT plan, upgrade_status FROM users WHERE id = $1',
      [req.user.id]
    );
    const planName  = planRow.rows[0]?.plan || 'Free';
    const isActive  = planRow.rows[0]?.upgrade_status === 'validé';
    const membLimit = getMembersLimit(isActive ? planName : 'Free');

    if (membLimit === 0) {
      return res.status(402).json({
        error:            'Plan insuffisant',
        code:             'PLAN_INSUFFICIENT',
        message:          `Le plan ${planName} ne permet pas d'inviter des employés. Passez au plan Business ou Enterprise.`,
        upgrade_required: true,
      });
    }

    // ✅ Infinity = pas de vérification de quota
    if (isFinite(membLimit)) {
      const { rows: existing } = await db.query(
        "SELECT COUNT(*)::int AS cnt FROM boutique_members WHERE boutique_id = $1 AND status != 'rejected'",
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

    // ── Résoudre la boutique cible ──
    // Priorité : paramètre body > header X-Boutique-Id > boutique primaire
    let targetBoutiqueId = parseInt(reqBoutiqueId || req.user.boutique_id || '0') || null;

    if (targetBoutiqueId) {
      // Vérifier que cette boutique appartient bien à cet owner
      const own = await db.query(
        'SELECT id FROM boutiques WHERE id = $1 AND owner_id = $2',
        [targetBoutiqueId, req.user.id]
      );
      if (!own.rows.length) {
        return res.status(403).json({ error: 'Boutique introuvable ou accès refusé' });
      }
    } else {
      // Utiliser la boutique primaire
      const primary = await db.query(
        'SELECT id FROM boutiques WHERE owner_id = $1 AND is_primary = true LIMIT 1',
        [req.user.id]
      );
      targetBoutiqueId = primary.rows[0]?.id || null;
    }

    // ── Vérifier si l'email est déjà invité dans CETTE boutique ──
    const dup = await db.query(
      `SELECT id FROM boutique_members
       WHERE boutique_id = $1 AND email = $2
         AND (ref_boutique_id = $3 OR ($3 IS NULL AND ref_boutique_id IS NULL))`,
      [req.user.id, email, targetBoutiqueId]
    );
    if (dup.rows.length) {
      return res.status(400).json({ error: 'Cet email est déjà invité dans cette boutique' });
    }

    // ── Permissions par défaut ──
    const defaultPerms = role === 'gerant'
      ? { vente:true, stock:true, categories:true, rapports:true, caisse:true, credits:true, clients:true, fournisseurs:true, commandes:true, livraisons:true }
      : { vente:true, stock:false, categories:false, rapports:false, caisse:false, credits:false, clients:false, fournisseurs:false, commandes:false, livraisons:false };

    const finalPerms = permissions || defaultPerms;
    const token      = crypto.randomBytes(32).toString('hex');
    const expiresAt  = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);

    const { rows } = await db.query(`
      INSERT INTO boutique_members
        (boutique_id, owner_user_id, ref_boutique_id, email, role,
         status, permissions, invite_token, invite_expires_at)
      VALUES ($1, $1, $2, $3, $4, 'pending', $5, $6, $7)
      RETURNING *
    `, [req.user.id, targetBoutiqueId, email, role, finalPerms, token, expiresAt]);

    // Récupérer le nom de la boutique cible pour le lien
    let boutiqueName = '';
    if (targetBoutiqueId) {
      const bRow = await db.query('SELECT name FROM boutiques WHERE id = $1', [targetBoutiqueId]);
      boutiqueName = bRow.rows[0]?.name || '';
    }

    const origin   = req.headers.origin || 'https://samacommerce-frontend-v2-1.onrender.com';
    const inviteUrl = `${origin}/login/login.html?invite=${token}&email=${encodeURIComponent(email)}`;

    res.status(201).json({
      message:      'Invitation envoyée',
      member:       rows[0],
      boutique_name: boutiqueName,
      invite_link:  inviteUrl,
    });
  } catch (err) {
    console.error('POST /members/invite:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /members/accept ── Accepter une invitation ───────────────
router.post('/accept', verifyToken, async (req, res) => {
  const { invite_token } = req.body;
  if (!invite_token) return res.status(400).json({ error: 'Token requis' });

  try {
    const { rows } = await db.query(
      "SELECT * FROM boutique_members WHERE invite_token = $1 AND status = 'pending'",
      [invite_token]
    );

    if (!rows.length) {
      // Vérifier si déjà accepté
      const memberId = req.user.realId || req.user.id;
      const { rows: alreadyAccepted } = await db.query(`
        SELECT bm.*, u.company_name, u.username AS boutique_email,
               b.name AS boutique_name, b.emoji AS boutique_emoji
        FROM boutique_members bm
        JOIN users u    ON bm.boutique_id = u.id
        LEFT JOIN boutiques b ON bm.ref_boutique_id = b.id
        WHERE bm.member_id = $1 AND bm.status = 'accepted'
        LIMIT 1
      `, [memberId]);

      if (alreadyAccepted.length) {
        return res.json({
          message:      'Vous êtes déjà membre de cette boutique',
          already_member: true,
          boutique: {
            id:           alreadyAccepted[0].boutique_id,
            boutique_id:  alreadyAccepted[0].ref_boutique_id,
            company_name: alreadyAccepted[0].company_name,
            name:         alreadyAccepted[0].boutique_name,
            emoji:        alreadyAccepted[0].boutique_emoji,
          },
          role:        alreadyAccepted[0].role,
          permissions: alreadyAccepted[0].permissions,
        });
      }
      return res.status(404).json({ error: 'Invitation invalide ou expirée' });
    }

    const invite = rows[0];

    // Vérifier expiration
    if (invite.invite_expires_at && new Date(invite.invite_expires_at) < new Date()) {
      await db.query(
        "UPDATE boutique_members SET status='rejected' WHERE id=$1",
        [invite.id]
      );
      return res.status(410).json({ error: 'Cette invitation a expiré. Demandez une nouvelle invitation.' });
    }

    const memberId = req.user.realId || req.user.id;
    await db.query(`
      UPDATE boutique_members
      SET status = 'accepted', member_id = $1, accepted_at = NOW(), invite_token = NULL
      WHERE id = $2
    `, [memberId, invite.id]);

    // Récupérer les infos de l'owner ET de la boutique spécifique
    const { rows: ownerRow } = await db.query(
      'SELECT id, company_name, username FROM users WHERE id = $1',
      [invite.boutique_id]
    );
    let boutiqueInfo = { id: invite.boutique_id, company_name: ownerRow[0]?.company_name };

    if (invite.ref_boutique_id) {
      const { rows: bRow } = await db.query(
        'SELECT id, name, emoji FROM boutiques WHERE id = $1',
        [invite.ref_boutique_id]
      );
      if (bRow.length) {
        boutiqueInfo = { ...boutiqueInfo, boutique_id: bRow[0].id, name: bRow[0].name, emoji: bRow[0].emoji };
      }
    }

    res.json({
      message:     'Invitation acceptée',
      boutique:    boutiqueInfo,
      permissions: invite.permissions,
      role:        invite.role,
    });
  } catch (err) {
    console.error('POST /members/accept:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PATCH /members/:id ── Modifier permissions ────────────────────
router.patch('/:id', verifyToken, async (req, res) => {
  const { permissions, role } = req.body;
  try {
    const { rows } = await db.query(`
      UPDATE boutique_members
      SET permissions = COALESCE($1, permissions),
          role        = COALESCE($2, role)
      WHERE id = $3 AND boutique_id = $4
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

// ── DELETE /members/:id ── Retirer un membre ──────────────────────
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { rows: existing } = await db.query(
      'SELECT id, member_id, boutique_id FROM boutique_members WHERE id = $1',
      [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Membre introuvable' });
    if (String(existing[0].boutique_id) !== String(req.user.id)) {
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

// ── GET /members/my-boutique ── Infos boutique pour un employé ────
router.get('/my-boutique', verifyToken, async (req, res) => {
  try {
    const memberId = req.user.realId || req.user.id;
    const { rows } = await db.query(`
      SELECT bm.permissions, bm.role, bm.ref_boutique_id,
             u.id AS owner_id, u.company_name, u.username AS boutique_email,
             b.name AS boutique_name, b.emoji AS boutique_emoji
      FROM boutique_members bm
      JOIN users    u ON bm.boutique_id = u.id
      LEFT JOIN boutiques b ON bm.ref_boutique_id = b.id
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

// ── POST /members/:id/resend ── Rengénérer un lien d'invitation ───
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

    const origin = req.headers.origin || 'https://samacommerce-frontend-v2-1.onrender.com';
    const link   = `${origin}/login/login.html?invite=${token}&email=${encodeURIComponent(rows[0].email)}`;

    res.json({ message: 'Lien renvoyé', invite_link: link, expires_at: expiresAt });
  } catch (err) {
    console.error('POST /members/:id/resend:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
