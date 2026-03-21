// middleware/rateLimit.js
// Rate limiter en mémoire sans dépendance externe
// Max 10 tentatives par IP sur /auth/login par fenêtre de 15 minutes

const _attempts = new Map();

const WIN_MS = 15 * 60 * 1000; // 15 minutes
const MAX    = 10;

function loginRateLimit(req, res, next) {
  const ip  = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();

  let entry = _attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WIN_MS };
  }
  entry.count++;
  _attempts.set(ip, entry);

  // Nettoyage anti-fuite mémoire (max 5000 IPs)
  if (_attempts.size > 5000) {
    for (const [k, v] of _attempts) {
      if (now > v.resetAt) _attempts.delete(k);
    }
  }

  if (entry.count > MAX) {
    const retryIn = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryIn);
    return res.status(429).json({
      error: `Trop de tentatives de connexion. Réessayez dans ${Math.ceil(retryIn / 60)} minute(s).`
    });
  }

  next();
}

// Réinitialiser après une connexion réussie (pour ne pas pénaliser les légitimes)
function resetLimit(ip) {
  _attempts.delete(ip);
}

module.exports = { loginRateLimit, resetLimit };
