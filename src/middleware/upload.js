const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { sanitizeSvg, MAX_SVG_SIZE } = require('../utils/sanitizeSvg');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 Mo
const UPLOAD_DIR = path.join(__dirname, '../../uploads/listings');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// Écrit un buffer déjà vérifié sur disque, sous un nom aléatoire (jamais le
// nom d'origine), dans le dossier fourni. Renvoie le nom de fichier ou null
// si le contenu n'est pas une vraie image JPG/PNG.
function persistBuffer(buffer, destDir) {
  const realMimeType = detectRealMimeType(buffer);
  if (!realMimeType) return null;

  fs.mkdirSync(destDir, { recursive: true });
  const extension = realMimeType === 'image/png' ? '.png' : '.jpg';
  const filename = `${crypto.randomBytes(16).toString('hex')}${extension}`;
  fs.writeFileSync(path.join(destDir, filename), buffer);
  return filename;
}

// À chaîner après upload.single('image') : écrit le fichier sur disque une
// fois le contenu vérifié (galerie prestataire).
function persistVerifiedImage(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ message: 'Aucun fichier reçu.' });
  }

  const filename = persistBuffer(req.file.buffer, UPLOAD_DIR);
  if (!filename) {
    return res
      .status(400)
      .json({ message: 'Format de fichier non supporté. Utilisez JPG ou PNG.' });
  }

  req.uploadedFile = { filename, url: `/uploads/listings/${filename}` };
  return next();
}

// Verifie/ecrit un fichier image optionnel (contrairement a la galerie
// photos ou l'image est obligatoire) - utilise par les vehicules et leurs
// modeles de decoration, qui peuvent etre crees/modifies sans photo.
function persistOptionalImage(file, res) {
  if (!file) return { imageUrl: undefined, error: null };

  const realMimeType = detectRealMimeType(file.buffer);
  if (!realMimeType) {
    res.status(400).json({ message: 'Image invalide. Utilisez JPG ou PNG.' });
    return { imageUrl: undefined, error: true };
  }

  const filename = persistBuffer(file.buffer, UPLOAD_DIR);
  return { imageUrl: `/uploads/listings/${filename}`, error: null };
}

// Remplace la valeur d'un champ image sur une instance Sequelize par la
// nouvelle URL, en supprimant l'ancien fichier du disque (best-effort, non
// bloquant). No-op si aucune nouvelle image n'a ete fournie.
function replaceStoredFile(instance, field, newImageUrl) {
  if (!newImageUrl) return;
  const previousImage = instance[field];
  instance[field] = newImageUrl;
  if (previousImage?.startsWith('/uploads/listings/')) {
    const previousPath = path.join(UPLOAD_DIR, path.basename(previousImage));
    fs.unlink(previousPath, () => {});
  }
}

const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50 Mo
const VIDEO_UPLOAD_DIR = path.join(__dirname, '../../uploads/videos');

fs.mkdirSync(VIDEO_UPLOAD_DIR, { recursive: true });

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

// Écrit un buffer video deja verifie sur disque, nom aleatoire. Renvoie le
// nom de fichier ou null si le contenu n'est pas un vrai MP4/WebM.
function persistVideoBuffer(buffer) {
  const realMimeType = detectRealVideoMimeType(buffer);
  if (!realMimeType) return null;

  const extension = realMimeType === 'video/webm' ? '.webm' : '.mp4';
  const filename = `${crypto.randomBytes(16).toString('hex')}${extension}`;
  fs.writeFileSync(path.join(VIDEO_UPLOAD_DIR, filename), buffer);
  return filename;
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
// le contenu est assaini (voir utils/sanitizeSvg.js) avant d'etre ecrit sur
// disque. Limite basse (100 Ko) car une icone n'a pas besoin de plus.
const ICON_UPLOAD_DIR = path.join(__dirname, '../../uploads/icons');
fs.mkdirSync(ICON_UPLOAD_DIR, { recursive: true });

const uploadIcon = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SVG_SIZE },
});

// A chainer apres uploadIcon.single('icon') : assainit puis ecrit le SVG sur
// disque sous un nom aleatoire (jamais le nom d'origine).
function persistVerifiedIcon(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ message: 'Aucun fichier reçu.' });
  }

  const sanitized = sanitizeSvg(req.file.buffer);
  if (!sanitized) {
    return res.status(400).json({ message: 'Fichier SVG invalide ou non supporté.' });
  }

  const filename = `${crypto.randomBytes(16).toString('hex')}.svg`;
  fs.writeFileSync(path.join(ICON_UPLOAD_DIR, filename), sanitized);

  req.uploadedFile = { filename, url: `/uploads/icons/${filename}` };
  return next();
}

// Documents legaux sensibles (carte CIN du gerant...) - CLAUDE.md, section
// Securite : "acces restreint, chiffrement au repos si possible". Stocke
// volontairement HORS de backend/uploads (jamais servi par le
// `express.static('/uploads', ...)` de app.js, contrairement aux
// photos/videos) : seul un endpoint authentifie (proprietaire de la fiche ou
// admin) peut les lire, jamais une URL publique devinable.
const LEGAL_UPLOAD_DIR = path.join(__dirname, '../../private-uploads/legal');
fs.mkdirSync(LEGAL_UPLOAD_DIR, { recursive: true });

module.exports = {
  upload,
  persistVerifiedImage,
  persistOptionalImage,
  replaceStoredFile,
  persistBuffer,
  detectRealMimeType,
  UPLOAD_DIR,
  uploadVideoFields,
  uploadThumbnailOnly,
  persistVideoBuffer,
  detectRealVideoMimeType,
  VIDEO_UPLOAD_DIR,
  LEGAL_UPLOAD_DIR,
  uploadIcon,
  persistVerifiedIcon,
  ICON_UPLOAD_DIR,
};
