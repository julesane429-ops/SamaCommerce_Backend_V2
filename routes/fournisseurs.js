// routes/fournisseurs.js — Fournisseurs v2 + liaison produits + réappro WhatsApp
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const verifyToken = require('../middleware/auth');
const perm        = require('../middleware/checkPermission');

router.get('/', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT f.*,
        COUNT(DISTINCT sp.product_id)::int  AS nb_produits,
        COALESCE(SUM(ro.total),0)::numeric  AS total_commandes,
        COUNT(DISTINCT ro.id)::int          AS nb_commandes_restock
      FROM fournisseurs f
      LEFT JOIN supplier_products sp ON sp.fournisseur_id = f.id
      LEFT JOIN restock_orders    ro ON ro.fournisseur_id = f.id
      WHERE f.user_id = $1
      GROUP BY f.id ORDER BY f.name
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { rows: f } = await db.query('SELECT * FROM fournisseurs WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!f.length) return res.status(404).json({ error: 'Fournisseur introuvable' });

    const { rows: produits } = await db.query(`
      SELECT sp.*, p.name, p.price, p.stock, p.stock_reserved, p.price_achat, p.image_url
      FROM supplier_products sp JOIN products p ON sp.product_id = p.id
      WHERE sp.fournisseur_id = $1
    `, [req.params.id]);

    const { rows: commandes } = await db.query(
      'SELECT * FROM restock_orders WHERE fournisseur_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.params.id]
    );

    res.json({ ...f[0], produits, commandes });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/', verifyToken, perm('fournisseurs'), async (req, res) => {
  const { name, phone, email, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  try {
    const { rows } = await db.query(
      'INSERT INTO fournisseurs (user_id, name, phone, email, address, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, name, phone||null, email||null, address||null, notes||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.patch('/:id', verifyToken, perm('fournisseurs'), async (req, res) => {
  const allowed = ['name','phone','email','address','notes'];
  const fields = [], values = [];
  let i = 1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key}=$${i++}`); values.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Rien à modifier' });
  try {
    values.push(req.params.id, req.user.id);
    const { rows } = await db.query(`UPDATE fournisseurs SET ${fields.join(',')} WHERE id=$${i} AND user_id=$${i+1} RETURNING *`, values);
    if (!rows.length) return res.status(404).json({ error: 'Fournisseur introuvable' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/:id', verifyToken, perm('fournisseurs'), async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM fournisseurs WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Fournisseur introuvable' });
    res.json({ message: 'Fournisseur supprimé' });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// Lier un produit
router.post('/:id/produits', verifyToken, perm('fournisseurs'), async (req, res) => {
  const { product_id, prix_achat_fournisseur, delai_livraison_jours } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id requis' });
  try {
    const { rows } = await db.query(`
      INSERT INTO supplier_products (fournisseur_id, product_id, prix_achat_fournisseur, delai_livraison_jours)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (fournisseur_id, product_id) DO UPDATE
        SET prix_achat_fournisseur=$3, delai_livraison_jours=$4
      RETURNING *
    `, [req.params.id, product_id, prix_achat_fournisseur||0, delai_livraison_jours||2]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.delete('/:id/produits/:pid', verifyToken, perm('fournisseurs'), async (req, res) => {
  try {
    await db.query('DELETE FROM supplier_products WHERE fournisseur_id=$1 AND product_id=$2', [req.params.id, req.params.pid]);
    res.json({ message: 'Produit délié' });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// Message réappro WhatsApp
router.get('/:id/reappro-message', verifyToken, async (req, res) => {
  try {
    const { rows: f } = await db.query('SELECT * FROM fournisseurs WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!f.length) return res.status(404).json({ error: 'Fournisseur introuvable' });

    const { rows: prods } = await db.query(`
      SELECT p.name, p.stock, p.stock_reserved, sp.prix_achat_fournisseur, sp.delai_livraison_jours
      FROM supplier_products sp JOIN products p ON sp.product_id = p.id
      WHERE sp.fournisseur_id = $1
        AND (p.stock - COALESCE(p.stock_reserved,0)) <= 5
      ORDER BY p.stock ASC
    `, [req.params.id]);

    const { rows: user } = await db.query('SELECT company_name FROM users WHERE id=$1', [req.user.id]);
    const boutique = user[0]?.company_name || 'Sama Commerce';

    const lignes = prods.length
      ? prods.map(p => `- ${p.name} × ${Math.max(1, 20-(p.stock-(p.stock_reserved||0)))} unités`).join('\n')
      : '(Préciser les produits et quantités)';

    const message = [
      `Bonjour ${f[0].name} 👋`,``,
      `Besoin de réapprovisionner :`,``,
      lignes,``,
      `📅 Date souhaitée : ${req.query.date || 'À confirmer'}`,``,
      `Merci de confirmer disponibilité et prix.`,``,
      `— ${boutique}`,
    ].join('\n');

    res.json({
      fournisseur: f[0],
      message,
      produits_faibles: prods,
      whatsapp_url: `https://wa.me/${(f[0].phone||'').replace(/\s+/g,'')}?text=${encodeURIComponent(message)}`,
    });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;
