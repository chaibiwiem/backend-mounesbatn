const db = require('../models');
const { encrypt } = require('../utils/secretCipher');
const emailService = require('../services/emailService');

const { PlatformSetting } = db;
const VALID_EMAIL_PROVIDERS = ['smtp', 'resend'];

// Reglages globaux (Parametres admin) : un seul enregistrement, cree a la
// premiere lecture/ecriture (voir models/PlatformSetting.js).
async function getSingleton() {
  let row = await PlatformSetting.findOne();
  if (!row) row = await PlatformSetting.create({});
  return row;
}

// Meme principe que listingController.getMyEmailSettings : le secret n'est
// jamais renvoye, seul un booleen indique s'il est deja enregistre.
exports.getEmailSettings = async (req, res, next) => {
  try {
    const row = await getSingleton();
    return res.json({
      provider: row.emailProvider || null,
      host: row.emailHost || '',
      port: row.emailPort || '',
      user: row.emailUser || '',
      fromEmail: row.emailFromEmail || '',
      hasPassword: Boolean(row.emailPassEncrypted),
      hasApiKey: Boolean(row.emailApiKeyEncrypted),
    });
  } catch (err) {
    return next(err);
  }
};

exports.updateEmailSettings = async (req, res, next) => {
  try {
    const row = await getSingleton();
    const { provider, host, port, user, fromEmail, pass, apiKey } = req.body;

    if (provider !== undefined && provider !== null && !VALID_EMAIL_PROVIDERS.includes(provider)) {
      return res.status(400).json({ message: 'Fournisseur email invalide.' });
    }

    if (provider !== undefined) row.emailProvider = provider;
    if (host !== undefined) row.emailHost = host;
    if (port !== undefined) row.emailPort = port;
    if (user !== undefined) row.emailUser = user;
    if (fromEmail !== undefined) row.emailFromEmail = fromEmail;
    // pass/apiKey non fournis = on conserve le secret deja enregistre ;
    // chaine vide explicite = suppression volontaire.
    if (pass !== undefined) row.emailPassEncrypted = pass ? encrypt(pass) : null;
    if (apiKey !== undefined) row.emailApiKeyEncrypted = apiKey ? encrypt(apiKey) : null;

    await row.save();
    emailService.clearPlatformSettingsCache();

    return res.json({
      provider: row.emailProvider || null,
      host: row.emailHost || '',
      port: row.emailPort || '',
      user: row.emailUser || '',
      fromEmail: row.emailFromEmail || '',
      hasPassword: Boolean(row.emailPassEncrypted),
      hasApiKey: Boolean(row.emailApiKeyEncrypted),
    });
  } catch (err) {
    return next(err);
  }
};

exports.sendTestEmail = async (req, res, next) => {
  try {
    const to = req.body.to || req.user.email;
    if (!to) {
      return res.status(400).json({ message: 'Adresse email de destination requise.' });
    }

    await emailService.sendPlatformTestEmail(to);
    return res.json({ message: `Email de test envoyé à ${to}.` });
  } catch (err) {
    return res.status(422).json({
      message: `Échec de l'envoi : ${err.message || 'vérifiez votre configuration.'}`,
    });
  }
};
