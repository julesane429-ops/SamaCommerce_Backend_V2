const jwt           = require('jsonwebtoken');
const employeeProxy = require('./employeeProxy');
const boutiqueCtx   = require('./boutiqueContext');

// verifyToken + employeeProxy + boutiqueContext en pipeline
async function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token      = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token manquant' });

  jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ message: 'Token invalide' });
    req.user = user;

    try {
      // 1. employeeProxy : si employé, remplace req.user.id par l'owner
      //    et fixe req.user.boutique_id sur la boutique assignée
      await new Promise((resolve) => employeeProxy(req, res, resolve));

      // 2. boutiqueContext : si propriétaire (boutique_id pas encore fixé),
      //    lit X-Boutique-Id ou prend la boutique primaire
      await boutiqueCtx(req, res, next);
    } catch (proxyErr) {
      console.error('verifyToken pipeline error:', proxyErr.message);
      next();
    }
  });
}

module.exports = verifyToken;
