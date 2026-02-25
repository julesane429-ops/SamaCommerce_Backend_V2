const jwt = require("jsonwebtoken");

function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader) {
    return res.status(401).json({ message: "Authorization header manquant" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Token manquant" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 🔐 On attache les infos utiles
    req.user = {
      id: decoded.id,
      shop_id: decoded.shop_id,
      role: decoded.role,
      username: decoded.username
    };

    next();
  } catch (err) {
    return res.status(403).json({ message: "Token invalide ou expiré" });
  }
}

module.exports = verifyToken;
