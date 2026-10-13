const crypto = require('crypto');

// Chiffrement au repos des identifiants SMTP/API renseignes par un
// prestataire (host/port/nom d'hote ne sont pas sensibles et restent en
// clair ; seuls le mot de passe SMTP et la cle API Resend passent ici).
// AES-256-GCM avec une cle derivee de process.env.ENCRYPTION_KEY (jamais
// commitee, cf. .env.example) - reversible, contrairement a bcrypt (mots de
// passe utilisateur) qui ne l'est jamais.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY manquante : impossible de chiffrer/dechiffrer des identifiants.');
  }
  // Accepte une cle hex (64 caracteres = 32 octets) ou toute chaine, hachee
  // en SHA-256 pour obtenir systematiquement 32 octets valides pour AES-256.
  return /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  const buffer = Buffer.from(encryptedText, 'base64');
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = buffer.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
