const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { sanitizeSvg, MAX_SVG_SIZE } = require('../utils/sanitizeSvg');
const storageService = require('../services/storageService');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 Mo
const UPLOAD_DIR = path.join(__dirname, '../../uploads/listings');

// Sur Vercel (serverless) le systeme de fichiers est en lecture seule : un
// mkdirSync qui echoue au chargement du module ferait planter toute l'API.
// On ignore l'erreur ici ; seul l'upload concerne echouera.
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`Dossier ${dir} non cree (${err.code})`);
  }
}

ensureDir(UPLOAD_DIR);

// Signature(s) binaire(s) de chaque format accepte, avec leur position dans
// le fichier. JPG (.jpg/.jpeg), PNG et WebP - un WebP commence par "RIFF",
// puis la taille (4 octets), puis "WEBP" a l'octet 8.
const MAGIC_BYTES = {
  'image/jpeg': [{ bytes: [0xff, 0xd8, 0xff], offset: 0 }],
  'image/png': [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 }],
  'image/webp': [
    { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
    { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  ],
};

const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// Détecte le vrai format à partir du contenu binaire (signature de fichier),
// jamais à partir de l'extension ou du Content-Type déclaré par le client
// (facilement falsifiables) — CLAUDE.md, section Uploads.
function detectRealMimeType(buffer) {
  const match = Object.entries(MAGIC_BYTES).find(([, signatures]) =>
    signatures.every(({ bytes, offset }) => bytes.every((byte, index) => buffer[offset + index] === byte))
  );
  return match ? match[0] : null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// Enregistre une image deja recue (disque local ou Cloudinary, voir
// storageService) apres verification du vrai format. Renvoie son URL, ou null
// si le contenu n'est pas une vraie image JPG/PNG/WebP. folder : "listings"
// (galerie, logos, categories, vehicules...) ou "reviews".
async function persistImage(buffer, folder = 'listings') {
  const realMimeType = detectRealMimeType(buffer);
  if (!realMimeType) return null;
  return storageService.saveFile(buffer, { folder, extension: EXTENSIONS[realMimeType] });
}

// À chaîner après upload.single('image') : enregistre le fichier une fois le
// contenu vérifié (galerie prestataire, logo, image de categorie).
async function persistVerifiedImage(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ message: 'Aucun fichier reçu.' });
  }

  try {
    const url = await persistImage(req.file.buffer);
    if (!url) {
      return res
        .status(400)
        .json({ message: 'Format de fichier non supporté. Utilisez JPG, PNG ou WebP.' });
    }
    req.uploadedFile = { url };
    return next();
  } catch (err) {
    return next(err);
  }
}

// Verifie/ecrit un fichier image optionnel (contrairement a la galerie
// photos ou l'image est obligatoire) - utilise par les vehicules et leurs
// modeles de decoration, qui peuvent etre crees/modifies sans photo.
async function persistOptionalImage(file, res) {
  if (!file) return { imageUrl: undefined, error: null };

  const imageUrl = await persistImage(file.buffer);
  if (!imageUrl) {
    res.status(400).json({ message: 'Image invalide. Utilisez JPG, PNG ou WebP.' });
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
  storageService.removeFile(previousImage);
}

const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50 Mo
const VIDEO_UPLOAD_DIR = path.join(__dirname, '../../uploads/videos');

ensureDir(VIDEO_UPLOAD_DIR);

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

// Enregistre une video apres verification du vrai format (nom aleatoire).
// Renvoie son URL ou null si le contenu n'est pas un vrai MP4/WebM.
async function persistVideo(buffer) {
  const realMimeType = detectRealVideoMimeType(buffer);
  if (!realMimeType) return null;

  const extension = realMimeType === 'video/webm' ? '.webm' : '.mp4';
  return storageService.saveFile(buffer, { folder: 'videos', extension, resourceType: 'video' });
}

// Accepte le champ 'video' (upload direct, galerie video) et/ou 'thumbnail'
// (vignette personnalisee JPG/PNG, optionnelle — pour un lien YouTube/Vimeo
// ou un upload direct). La verification/le stockage se font dans le
// controller (les deux champs ont des regles de format differentes).
const uploadVideoFields = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_SIZE },
});

// Accepte uniquement 'thumbnail' (JPG, PNG ou WebP, 5 Mo max comme les photos) —
// utilise pour l'ajout d'un lien video, ou aucun fichier video n'est envoye.
const uploadThumbnailOnly = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// Icone SVG d'une categorie (admin uniquement). Exception documentee a la
// regle "JPG, PNG ou WebP uniquement" de CLAUDE.md : un SVG est du texte/XML, pas une
// image binaire, donc pas de signature "magic bytes" a verifier - a la place
// le contenu est assaini (voir utils/sanitizeSvg.js) avant d'etre ecrit sur
// disque. Limite basse (100 Ko) car une icone n'a pas besoin de plus.
const ICON_UPLOAD_DIR = path.join(__dirname, '../../uploads/icons');
ensureDir(ICON_UPLOAD_DIR);

const uploadIcon = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SVG_SIZE },
});

// A chainer apres uploadIcon.single('icon') : assainit puis enregistre le SVG
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
    const url = await storageService.saveFile(Buffer.from(sanitized), { folder: 'icons', extension: '.svg' });
    req.uploadedFile = { url };
    return next();
  } catch (err) {
    return next(err);
  }
}

// Carte CIN : verifiee comme une photo (magic bytes), stockee en prive (voir
// storageService.saveLegalFile). Renvoie la reference a enregistrer en base
// (jamais une URL publique), ou null si format invalide.
async function persistLegalImage(buffer) {
  const realMimeType = detectRealMimeType(buffer);
  if (!realMimeType) return null;
  return storageService.saveLegalFile(buffer, EXTENSIONS[realMimeType]);
}

// Documents legaux sensibles (carte CIN du gerant...) - CLAUDE.md, section
// Securite : "acces restreint, chiffrement au repos si possible". Stocke
// volontairement HORS de backend/uploads (jamais servi par le
// `express.static('/uploads', ...)` de app.js, contrairement aux
// photos/videos) : seul un endpoint authentifie (proprietaire de la fiche ou
// admin) peut les lire, jamais une URL publique devinable.
const LEGAL_UPLOAD_DIR = path.join(__dirname, '../../private-uploads/legal');
ensureDir(LEGAL_UPLOAD_DIR);

module.exports = {
  upload,
  persistVerifiedImage,
  persistOptionalImage,
  replaceStoredFile,
  persistImage,
  persistLegalImage,
  detectRealMimeType,
  UPLOAD_DIR,
  uploadVideoFields,
  uploadThumbnailOnly,
  persistVideo,
  detectRealVideoMimeType,
  VIDEO_UPLOAD_DIR,
  LEGAL_UPLOAD_DIR,
  uploadIcon,
  persistVerifiedIcon,
  ICON_UPLOAD_DIR,
};
