// utils/mailer.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const APP_NAME = 'Sama Commerce';
const APP_URL  = process.env.FRONTEND_URL || 'https://samacommerce-frontend-v2-1.onrender.com';
const SUPPORT  = process.env.SUPPORT_PHONE || '+221 78 157 10 09';

/**
 * Envoi d'email avec support HTML
 * @param {string} to
 * @param {string} subject
 * @param {string} html - corps HTML
 * @param {string} [text] - fallback texte brut (optionnel)
 */
async function sendEmail(to, subject, html, text) {
  try {
    await transporter.sendMail({
      from: `"${APP_NAME}" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ''),
    });
    console.log(`📧 Email envoyé à ${to}: ${subject}`);
  } catch (err) {
    console.error('❌ Erreur envoi email:', err.message);
  }
}

// ══════════════════════════════════════
// TEMPLATES EMAIL
// ══════════════════════════════════════

function wrapTemplate(content) {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<style>
  body { font-family: 'Segoe UI', sans-serif; background: #F9FAFB; margin: 0; padding: 20px; }
  .card { background: #fff; border-radius: 16px; max-width: 480px; margin: 0 auto; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  .header { background: linear-gradient(135deg, #5B21B6, #7C3AED); padding: 28px 24px; text-align: center; }
  .header h1 { color: #fff; font-size: 20px; margin: 0; }
  .header p  { color: rgba(255,255,255,.8); font-size: 13px; margin: 6px 0 0; }
  .body { padding: 24px; color: #374151; line-height: 1.6; }
  .body p { margin: 0 0 14px; font-size: 14px; }
  .btn { display: inline-block; background: linear-gradient(135deg, #7C3AED, #EC4899); color: #fff !important;
         text-decoration: none; padding: 12px 28px; border-radius: 12px; font-weight: 700; font-size: 14px;
         margin: 8px 0 16px; }
  .alert { background: #FEF2F2; border-left: 4px solid #EF4444; border-radius: 8px; padding: 12px 16px;
           font-size: 13px; color: #991B1B; margin-bottom: 16px; }
  .info  { background: #EFF6FF; border-left: 4px solid #3B82F6; border-radius: 8px; padding: 12px 16px;
           font-size: 13px; color: #1E40AF; margin-bottom: 16px; }
  .warn  { background: #FFFBEB; border-left: 4px solid #F59E0B; border-radius: 8px; padding: 12px 16px;
           font-size: 13px; color: #92400E; margin-bottom: 16px; }
  .footer { background: #F3F4F6; padding: 14px 24px; text-align: center; font-size: 11px; color: #9CA3AF; }
</style></head><body>
<div class="card">
  <div class="header">
    <h1>⭐ ${APP_NAME}</h1>
    <p>Gérez votre boutique simplement</p>
  </div>
  <div class="body">${content}</div>
  <div class="footer">📞 ${SUPPORT} · <a href="${APP_URL}" style="color:#7C3AED;">Accéder à l'app</a></div>
</div></body></html>`;
}

function emailRappel7J(user) {
  const exp = new Date(user.expiration).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  return {
    subject: `⏳ Votre abonnement expire dans 7 jours — ${APP_NAME}`,
    html: wrapTemplate(`
      <p>Bonjour <strong>${user.company_name || user.username}</strong>,</p>
      <div class="warn">⚠️ Votre abonnement <strong>Premium</strong> expire le <strong>${exp}</strong> (dans 7 jours).</div>
      <p>Pour continuer à bénéficier de toutes les fonctionnalités sans interruption, renouvelez dès maintenant.</p>
      <a href="${APP_URL}" class="btn">🚀 Renouveler mon abonnement</a>
      <p>Pour renouveler, connectez-vous et cliquez sur votre profil → <strong>Passer en Premium</strong>.</p>
      <p>📞 Besoin d'aide ? Contactez-nous au <strong>${SUPPORT}</strong></p>
    `),
  };
}

function emailRappel3J(user) {
  const exp = new Date(user.expiration).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  return {
    subject: `🚨 Plus que 3 jours — Renouvelez votre Premium — ${APP_NAME}`,
    html: wrapTemplate(`
      <p>Bonjour <strong>${user.company_name || user.username}</strong>,</p>
      <div class="alert">🚨 Votre abonnement <strong>Premium</strong> expire le <strong>${exp}</strong> (dans 3 jours).</div>
      <p>Après cette date, votre boutique sera <strong>limitée au plan Gratuit</strong> : maximum 5 produits, pas de rapports, pas d'équipe.</p>
      <a href="${APP_URL}" class="btn">⚡ Renouveler maintenant</a>
      <p>📞 Paiement rapide par Wave, Orange Money ou espèces : <strong>${SUPPORT}</strong></p>
    `),
  };
}

function emailExpiration(user) {
  return {
    subject: `❌ Abonnement expiré — Reprenez le contrôle — ${APP_NAME}`,
    html: wrapTemplate(`
      <p>Bonjour <strong>${user.company_name || user.username}</strong>,</p>
      <div class="alert">❌ Votre abonnement <strong>Premium</strong> a expiré aujourd'hui.</div>
      <p>Votre boutique est maintenant en <strong>plan Gratuit</strong>. Vos données sont <strong>conservées</strong>, mais certaines fonctionnalités sont désactivées :</p>
      <ul style="font-size:13px;color:#6B7280;margin:0 0 16px;padding-left:20px;">
        <li>Limite de 5 produits actifs</li>
        <li>Rapports et export Excel désactivés</li>
        <li>Gestion d'équipe désactivée</li>
      </ul>
      <a href="${APP_URL}" class="btn">🔄 Renouveler mon abonnement</a>
      <p>📞 Contactez-nous pour renouveler : <strong>${SUPPORT}</strong></p>
    `),
  };
}

function emailBienvenuePremium(user, expirationDate) {
  const exp = new Date(expirationDate).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  return {
    subject: `✅ Bienvenue en Premium ! — ${APP_NAME}`,
    html: wrapTemplate(`
      <p>Bonjour <strong>${user.company_name || user.username}</strong>,</p>
      <div class="info">✅ Votre abonnement <strong>Premium</strong> est maintenant actif jusqu'au <strong>${exp}</strong>.</div>
      <p>Vous avez maintenant accès à toutes les fonctionnalités :</p>
      <ul style="font-size:13px;color:#374151;margin:0 0 16px;padding-left:20px;">
        <li>✅ Produits illimités</li>
        <li>✅ Gestion d'équipe (3 employés)</li>
        <li>✅ Rapports avancés et export Excel</li>
        <li>✅ Photos produits</li>
        <li>✅ Rappels WhatsApp automatiques</li>
      </ul>
      <a href="${APP_URL}" class="btn">🏪 Accéder à ma boutique</a>
    `),
  };
}

module.exports = { sendEmail, emailRappel7J, emailRappel3J, emailExpiration, emailBienvenuePremium };
