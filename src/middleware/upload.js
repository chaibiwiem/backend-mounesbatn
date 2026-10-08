const path = require('path');
const multer = require('multer');
const { sanitizeSvg, MAX_SVG_SIZE } = require('../utils/sanitizeSvg');
const { storePublicFile, deleteStoredFile, storePrivateFile } = require('../services/storageService');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 Mo
// Dossier local des photos (dev) - en production les fichiers vont sur
// Cloudinary, voir services/storageService.js.
const UPLOAD_DIR = path.join(__dirname, '../../uploads/listings');
const VIDEO_UPLOAD_DIR = path.join(__dirname, '../../uploads/videos');
const LEGAL_UPLOAD_DIR = path.join(__dirname, '../../private-uploads/legal');

const MAGIC_BYTES = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

// Détecte le vrai format à partir du contenu binaire (signature de fichier),
// jamais à partir de l'extension ou du Content-Type déclaré par le client
// (facilement falsifiables) — CLAUDE.md, section Uploads.
function detectRealMimeType(buffer) {
  const match = Object.entries(MAGIC_BYTES).find(([, signature]) =>
    signature.every((byte, index) => buffer[index] === byte)
  );
  return match ? match[0] : null;
}

const imageExtension = (mimeType) => (mimeType === 'image/png' ? '.png' : '.jpg');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// Stocke une image apres verification de son vrai format, sous un nom
// aleatoire (jamais le nom d'origine). Renvoie l'URL a enregistrer en base,
// ou null si le contenu n'est pas une vraie image JPG/PNG.
async function storeVerifiedImage(buffer, folder = 'listings') {
  const realMimeType = detectRealMimeType(buffer);
  if (!realMimeType) return null;
  return storePublicFile(buffer, { folder, extension: imageExtension(realMimeType) });
}

// À chaîner après upload.single('image') : stocke le fichier une fois le
// contenu vérifié (galerie prestataire).
async function persistVerifiedImage(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ message: 'Aucun fichier reçu.' });
  }

  try {
    const url = await storeVerifiedImage(req.file.buffer);
    if (!url) {
      return res
        .status(400)
        .json({ message: 'Format de fichier non supporté. Utilisez JPG ou PNG.' });
    }

    req.uploadedFile = { filename: path.basename(url), url };
    return next();
  } catch (err) {
    return next(err);
  }
}

// Verifie/stocke un fichier image optionnel (contrairement a la galerie
// photos ou l'image est obligatoire) - utilise par les vehicules et leurs
// modeles de decoration, qui peuvent etre crees/modifies sans photo.
async function persistOptionalImage(file, res) {
  if (!file) return { imageUrl: undefined, error: null };

  const imageUrl = await storeVerifiedImage(file.buffer);
  if (!imageUrl) {
    res.status(400).json({ message: 'Image invalide. Utilisez JPG ou PNG.' });
    return { imageUrl: undefined, error: true };
  }
  return { imageUrl, error: null };
}

// Remplace la valeur d'un champ image sur une instance Sequelize par la
// nouvelle URL, en supprimant l'ancien fichier (best-effort, non bloquant).
// No-op si aucune nouvelle image n'a ete fournie.
function replaceStoredFile(instance, field, newImageUrl) {
  if (!newImageUrl) return;
  const previousImage = instance[field];
  instance[field] = newImageUrl;
  deleteStoredFile(previousImage);
}

const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50 Mo

// mp4 : signature 'ftyp' a l'offset 4 (pas 0). webm : en-tete EBML a l'offset 0.
const VIDEO_MAGIC_BYTES = {
  'video/mp4': { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  'video/webm': { bytes: [0x1a, 0x45, 0xdf, 0xa3], offset: 0 },
};

function detectRealVideoMimeType(buffer) {
  const match = Object.entries(VIDEO_MAGIC_BYTES).find(([, sig]) =>
    sig.bytes.every((byte, index) => buffer[sig.offset + index] === byte)
  );
  return match ? match[0] : null;
}

// Stocke une video apres verification (vrai MP4/WebM), nom aleatoire.
// Renvoie l'URL a enregistrer en base, ou null si le format est invalide.
async function persistVideoBuffer(buffer) {
  const realMimeType = detectRealVideoMimeType(buffer);
  if (!realMimeType) return null;

  const extension = realMimeType === 'video/webm' ? '.webm' : '.mp4';
  return storePublicFile(buffer, { folder: 'videos', extension, resourceType: 'video' });
}

// Accepte le champ 'video' (upload direct, galerie video) et/ou 'thumbnail'
// (vignette personnalisee JPG/PNG, optionnelle — pour un lien YouTube/Vimeo
// ou un upload direct). La verification/le stockage se font dans le
// controller (les deux champs ont des regles de format differentes).
const uploadVideoFields = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_SIZE },
});

// Accepte uniquement 'thumbnail' (JPG/PNG, 5 Mo max comme les photos) —
// utilise pour l'ajout d'un lien video, ou aucun fichier video n'est envoye.
const uploadThumbnailOnly = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// Icone SVG d'une categorie (admin uniquement). Exception documentee a la
// regle "JPG/PNG uniquement" de CLAUDE.md : un SVG est du texte/XML, pas une
// image binaire, donc pas de signature "magic bytes" a verifier - a la place
// le contenu est assaini (voir utils/sanitizeSvg.js) avant d'etre stocke.
// Limite basse (100 Ko) car une icone n'a pas besoin de plus.
const uploadIcon = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SVG_SIZE },
});

// A chainer apres uploadIcon.single('icon') : assainit puis stocke le SVG
// sous un nom aleatoire (jamais le nom d'origine).
async function persistVerifiedIcon(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ message: 'Aucun fichier reçu.' });
  }

  const sanitized = sanitizeSvg(req.file.buffer);
  if (!sanitized) {
    return res.status(400).json({ message: 'Fichier SVG invalide ou non supporté.' });
  }

  try {
    const url = await storePublicFile(Buffer.from(sanitized), { folder: 'icons', extension: '.svg' });
    req.uploadedFile = { filename: path.basename(url), url };
    return next();
  } catch (err) {
    return next(err);
  }
}

// Documents legaux sensibles (carte CIN du gerant...) - CLAUDE.md, section
// Securite : "acces restreint, chiffrement au repos si possible". Jamais une
// URL publique : stockes en prive (Cloudinary "authenticated", ou en local
// hors de backend/uploads), lus uniquement par un endpoint authentifie.
const LEGAL_FOLDER = 'legal';

// Renvoie la reference a stocker en base, ou null si ce n'est pas un vrai
// JPG/PNG.
async function storeLegalImage(buffer) {
  const realMimeType = detectRealMimeType(buffer);
  if (!realMimeType) return null;
  return storePrivateFile(buffer, { folder: LEGAL_FOLDER, extension: imageExtension(realMimeType) });
}

module.exports = {
  upload,
  persistVerifiedImage,
  persistOptionalImage,
  replaceStoredFile,
  storeVerifiedImage,
  detectRealMimeType,
  UPLOAD_DIR,
  uploadVideoFields,
  uploadThumbnailOnly,
  persistVideoBuffer,
  detectRealVideoMimeType,
  VIDEO_UPLOAD_DIR,
  LEGAL_UPLOAD_DIR,
  LEGAL_FOLDER,
  storeLegalImage,
  uploadIcon,
  persistVerifiedIcon,
};
