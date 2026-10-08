const jwt = require('jsonwebtoken');
const { getProviderPlan } = require('../services/planService');

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentification requise.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Token invalide ou expiré.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Accès interdit.' });
    }
    return next();
  };
}

// Remplacement direct de requireRole pour toutes les routes prestataire :
// meme verification de role, PLUS un blocage (403) des actions d'ECRITURE
// (POST/PATCH/PUT/DELETE) si l'abonnement du prestataire est expire (date de
// fin depassee ou statut non "active"), quel que soit le plan souscrit —
// "desactiver l'utilisation apres expiration" (voir
// planService.isSubscriptionExpired). La LECTURE (GET) reste toujours
// autorisee : un abonnement expire passe en mode consultation seule (voir
// demandes/reservations/fiche existantes) plutot qu'un blocage total du
// dashboard - seule la creation/modification de contenu est desactivee.
// Comportement strictement identique a requireRole pour tout role autre que
// "provider" (et pour toute methode GET), donc sans risque a utiliser partout
// ou requireRole('provider', ...) etait utilise. Exception volontaire :
// routes/subscriptions.js garde requireRole('provider') nu, pour que le
// prestataire puisse toujours consulter son abonnement expire.
function requireActiveProvider(...roles) {
  return async (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Accès interdit.' });
    }
    if (req.user.role !== 'provider' || req.method === 'GET') {
      return next();
    }
    try {
      const { isExpired, subscription } = await getProviderPlan(req.user.id);
      if (isExpired) {
        return res.status(403).json({
          message: subscription?.endDate
            ? `Votre abonnement a expiré le ${subscription.endDate}. Contactez l'administrateur pour le renouveler avant de pouvoir ajouter ou modifier du contenu.`
            : "Votre abonnement n'est plus actif. Contactez l'administrateur pour le renouveler avant de pouvoir ajouter ou modifier du contenu.",
          subscriptionExpired: true,
        });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// Restreint une action admin a des sous-roles precis (super_admin, moderator,
// support, analyst) — CLAUDE.md / MODULES.md M10. Le super_admin a toujours
// acces a tout, sans avoir besoin d'etre liste explicitement a chaque appel.
// A chainer apres requireRole('admin').
function requireAdminRole(...allowedAdminRoles) {
  return (req, res, next) => {
    const adminRole = req.user?.adminRole;
    if (adminRole === 'super_admin' || allowedAdminRoles.includes(adminRole)) {
      return next();
    }
    return res.status(403).json({ message: 'Accès interdit pour ce rôle administrateur.' });
  };
}

// Décode le token s'il est présent, sans jamais bloquer la requête : utilisé
// pour les routes accessibles aux visiteurs anonymes ET aux clients connectés
// (ex. POST /api/leads), où seul le rôle doit être distingué quand connu.
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      req.user = null;
    }
  }

  return next();
}

module.exports = { verifyToken, requireRole, requireActiveProvider, requireAdminRole, optionalAuth };
