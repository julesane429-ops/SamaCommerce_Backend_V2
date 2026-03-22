const jwt          = require('jsonwebtoken');
const employeeProxy = require('./employeeProxy');

// verifyToken + employeeProxy combinés en un seul middleware
// L'ordre est important : JWT d'abord, puis proxy employé
async function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token      = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token manquant' });

  jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ message: 'Token invalide' });
    req.user = user;

    // Appliquer le proxy employé maintenant que req.user est défini
    // (évite le problème de l'ancien app.use(employeeProxy) global qui tournait avant JWT)
    try {
      await employeeProxy(req, res, next);
    } catch (proxyErr) {
      console.error('verifyToken proxy error:', proxyErr.message);
      next();
    }
  });
}

module.exports = verifyToken;
