const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const db = require('../models');
const emailService = require('../services/emailService');

const { User, Listing, Lead, Booking, Sequelize } = db;
const BCRYPT_COST = 12;

// Les jetons envoyes par email (verification, reinitialisation du mot de
// passe) ne sont stockes en base que sous forme de hash SHA-256 : une fuite
// de la base ne permet donc pas de reinitialiser un mot de passe ni de
// valider un compte. Le jeton en clair n'existe que dans le lien de l'email.
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, adminRole: user.adminRole || null },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
  );
}

function signRefreshToken(user) {
  return jwt.sign({ id: user.id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  });
}

async function toPublicUser(user) {
  const publicUser = {
    id: user.id,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    emailVerified: user.emailVerified,
    adminRole: user.adminRole || null,
    weddingRole: user.weddingRole || null,
    lastLoginAt: user.lastLoginAt,
  };

  // Le frontend prestataire a besoin de connaitre sa fiche pour consulter ses
  // leads (GET /api/listings/:id/leads) sans endpoint "mes fiches" dedie.
  if (user.role === 'provider') {
    const listing = await Listing.findOne({ where: { userId: user.id } });
    publicUser.listingId = listing ? listing.id : null;
  }

  return publicUser;
}

exports.register = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { firstName, lastName, email, phone, password, weddingRole } = req.body;

  try {
    const existingEmail = await User.findOne({ where: { email } });
    if (existingEmail) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé.' });
    }

    if (phone) {
      const existingPhone = await User.findOne({ where: { phone } });
      if (existingPhone) {
        return res.status(409).json({ message: 'Ce numéro de téléphone est déjà utilisé.' });
      }
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const emailVerifyToken = crypto.randomBytes(32).toString('hex');

    // Inscription publique reservee aux clients (CLAUDE.md) : les comptes
    // prestataires sont exclusivement crees par l'admin (onboarding assisté,
    // module M10 / adminController.createProvider).
    const user = await User.create({
      role: 'client',
      firstName,
      lastName,
      email,
      phone,
      passwordHash,
      emailVerifyToken: hashToken(emailVerifyToken),
      weddingRole: weddingRole || null,
    });

    await emailService.sendVerificationEmail(user, emailVerifyToken);

    return res.status(201).json({
      message: 'Inscription réussie. Vérifiez votre email pour activer votre compte.',
      user: await toPublicUser(user),
    });
  } catch (err) {
    return next(err);
  }
};

exports.verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.params;
    // Repli sur le jeton en clair : comptes inscrits avant le hachage des
    // jetons, dont le lien de verification n'a pas encore ete utilise.
    const user = await User.findOne({
      where: { emailVerifyToken: { [Sequelize.Op.in]: [hashToken(token), token] } },
    });

    if (!user) {
      return res.status(400).json({ message: 'Lien de vérification invalide.' });
    }

    user.emailVerified = true;
    user.emailVerifyToken = null;
    await user.save();

    // Demandes envoyees sans compte avec cette adresse (desormais prouvee) :
    // rattachees au compte, avec leurs reservations - le client les retrouve
    // dans son espace et peut laisser un avis verifie (M8, invitation M13).
    if (user.role === 'client') {
      const guestLeads = await Lead.findAll({ where: { email: user.email, userId: null }, attributes: ['id'] });
      const leadIds = guestLeads.map((lead) => lead.id);
      if (leadIds.length > 0) {
        await Lead.update({ userId: user.id }, { where: { id: leadIds } });
        await Booking.update({ userId: user.id }, { where: { leadId: leadIds, userId: null } });
      }
    }

    return res.json({ message: 'Email vérifié avec succès.' });
  } catch (err) {
    return next(err);
  }
};

exports.login = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password } = req.body;
  const genericError = { message: 'Identifiants invalides.' };

  try {
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(401).json(genericError);
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json(genericError);
    }

    if (!user.emailVerified) {
      return res
        .status(403)
        .json({ message: 'Veuillez vérifier votre email avant de vous connecter.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'Ce compte a été désactivé.' });
    }

    const token = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    // Affiche cote Parametres (admin) - "Derniere connexion". Non bloquant
    // pour la reponse : la connexion reussit meme si cette ecriture echoue.
    user.lastLoginAt = new Date();
    await user.save();

    return res.json({ token, refreshToken, user: await toPublicUser(user) });
  } catch (err) {
    return next(err);
  }
};

exports.refreshToken = async (req, res, next) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ message: 'refreshToken requis.' });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findByPk(decoded.id);

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Session invalide.' });
    }

    return res.json({ token: signAccessToken(user) });
  } catch (err) {
    return res.status(401).json({ message: 'Refresh token invalide ou expiré.' });
  }
};

// Rafraichit le profil utilisateur mis en cache cote frontend (localStorage) :
// necessaire par ex. quand un champ comme adminRole est ajoute/modifie apres
// la derniere connexion, sans forcer un logout/login manuel.
exports.me = async (req, res, next) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    return res.json({ user: await toPublicUser(user) });
  } catch (err) {
    return next(err);
  }
};

// Mise a jour de l'identite du compte connecte (Parametres > Mon profil,
// tous roles) - distinct de la fiche prestataire (listingController), qui
// concerne les infos publiques de l'entreprise, pas le compte utilisateur
// lui-meme. Pas de changement de role/adminRole ici (jamais auto-assigne).
exports.updateMe = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { firstName, lastName, email } = req.body;

  try {
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    if (email !== undefined && email !== user.email) {
      const existing = await User.findOne({ where: { email } });
      if (existing) {
        return res.status(409).json({ message: 'Cet email est déjà utilisé.' });
      }
      user.email = email;
      // Changement d'adresse = nouvelle verification requise (CLAUDE.md -
      // verification par email), meme mecanisme qu'a l'inscription.
      user.emailVerified = false;
      const emailVerifyToken = crypto.randomBytes(32).toString('hex');
      user.emailVerifyToken = hashToken(emailVerifyToken);
      await emailService.sendVerificationEmail(user, emailVerifyToken);
    }

    if (firstName !== undefined) user.firstName = firstName;
    if (lastName !== undefined) user.lastName = lastName;

    await user.save();

    return res.json({ user: await toPublicUser(user) });
  } catch (err) {
    return next(err);
  }
};

exports.forgotPassword = async (req, res, next) => {
  const genericResponse = {
    message: 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.',
  };
  const { email } = req.body;

  try {
    const user = await User.findOne({ where: { email } });

    // Ne jamais révéler si l'email existe (US-C03).
    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      user.resetToken = hashToken(resetToken);
      user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
      await user.save();
      await emailService.sendPasswordResetEmail(user, resetToken);
    }

    return res.json(genericResponse);
  } catch (err) {
    return next(err);
  }
};

exports.resetPassword = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { token } = req.params;
  const { password } = req.body;

  try {
    const user = await User.findOne({
      where: {
        resetToken: hashToken(token),
        resetTokenExpires: { [Sequelize.Op.gt]: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({ message: 'Lien invalide ou expiré.' });
    }

    user.passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    user.resetToken = null;
    user.resetTokenExpires = null;
    await user.save();

    return res.json({ message: 'Mot de passe réinitialisé avec succès.' });
  } catch (err) {
    return next(err);
  }
};

// Changement de mot de passe par l'utilisateur connecté (ex. prestataire
// onboardé par l'admin qui remplace son mot de passe temporaire).
exports.changePassword = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { currentPassword, newPassword } = req.body;

  try {
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    const passwordMatches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ message: 'Mot de passe actuel incorrect.' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await user.save();

    return res.json({ message: 'Mot de passe modifié avec succès.' });
  } catch (err) {
    return next(err);
  }
};
