const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;

// Stockage des fichiers envoyes (photos, videos, icones, documents legaux).
// - CLOUDINARY_URL defini (production Vercel, disque en lecture seule) :
//   fichiers envoyes sur Cloudinary, l'URL https complete est stockee en base.
// - Sinon (dev local) : disque, sous backend/uploads (public) ou
//   backend/private-uploads (prive), comme avant.
// Configuration : soit CLOUDINARY_URL (lu tout seul par le SDK), soit les
// variables separees CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY /
// CLOUDINARY_API_SECRET.
const {
  CLOUDINARY_URL,
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = process.env;

const hasSeparateVars = Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
if (!CLOUDINARY_URL && hasSeparateVars) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const UPLOADS_ROOT = path.join(__dirname, '../../uploads');
const PRIVATE_ROOT = path.join(__dirname, '../../private-uploads');
// Dossier racine sur Cloudinary (tous les fichiers de la plateforme dessous).
const CLOUD_FOLDER = process.env.CLOUDINARY_FOLDER || 'mounesba';
const PRIVATE_PREFIX = 'cloudinary:';

const isCloudEnabled = () => Boolean(CLOUDINARY_URL || hasSeparateVars);

// Nom aleatoire, jamais le nom d'origine (CLAUDE.md - Uploads).
const randomName = () => crypto.randomBytes(16).toString('hex');

function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (err, result) => (err ? reject(err) : resolve(result)))
      .end(buffer);
  });
}

// Fichier public (affiche sur le site) - contenu DEJA verifie par l'appelant.
// Renvoie l'URL a stocker en base.
async function storePublicFile(buffer, { folder, extension, resourceType = 'image' }) {
  const name = randomName();

  if (isCloudEnabled()) {
    const result = await uploadToCloudinary(buffer, {
      folder: `${CLOUD_FOLDER}/${folder}`,
      public_id: name,
      resource_type: resourceType,
      overwrite: false,
    });
    return result.secure_url;
  }

  const dir = path.join(UPLOADS_ROOT, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}${extension}`), buffer);
  return `/uploads/${folder}/${name}${extension}`;
}

const CLOUDINARY_URL_RE =
  /^https:\/\/res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i;

// Suppression best effort (jamais bloquante) d'un fichier public, local ou
// Cloudinary. Ignore toute autre URL (ex. vignette YouTube).
function deleteStoredFile(url) {
  if (typeof url !== 'string') return;

  if (url.startsWith('/uploads/')) {
    // basename : impossible de sortir du dossier uploads (path traversal).
    const filePath = path.join(UPLOADS_ROOT, path.basename(path.dirname(url)), path.basename(url));
    fs.unlink(filePath, () => {});
    return;
  }

  const match = url.match(CLOUDINARY_URL_RE);
  if (match && match[2].startsWith(`${CLOUD_FOLDER}/`)) {
    cloudinary.uploader.destroy(match[2], { resource_type: match[1] }).catch(() => {});
  }
}

// Fichier prive (carte CIN...) : sur Cloudinary en type "authenticated",
// jamais accessible par une URL publique. Renvoie une reference a stocker en
// base (pas une URL) : "cloudinary:<public_id>.<format>" ou, en local, le nom
// de fichier seul (format historique).
async function storePrivateFile(buffer, { folder, extension }) {
  const name = randomName();

  if (isCloudEnabled()) {
    const result = await uploadToCloudinary(buffer, {
      folder: `${CLOUD_FOLDER}/${folder}`,
      public_id: name,
      resource_type: 'image',
      type: 'authenticated',
    });
    return `${PRIVATE_PREFIX}${result.public_id}.${result.format}`;
  }

  const dir = path.join(PRIVATE_ROOT, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}${extension}`), buffer);
  return `${name}${extension}`;
}

const contentTypeFor = (filename) =>
  path.extname(filename).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';

// Lit un fichier prive cote serveur (l'URL signee Cloudinary n'est jamais
// renvoyee au navigateur). Renvoie { buffer, contentType } ou null.
async function readPrivateFile(ref, folder) {
  if (!ref) return null;

  if (ref.startsWith(PRIVATE_PREFIX)) {
    const id = ref.slice(PRIVATE_PREFIX.length);
    const format = path.extname(id).slice(1);
    const url = cloudinary.url(id.slice(0, -(format.length + 1)), {
      type: 'authenticated',
      resource_type: 'image',
      sign_url: true,
      secure: true,
      format,
    });
    const response = await fetch(url);
    if (!response.ok) return null;
    return { buffer: Buffer.from(await response.arrayBuffer()), contentType: contentTypeFor(id) };
  }

  const filePath = path.join(PRIVATE_ROOT, folder, path.basename(ref));
  if (!fs.existsSync(filePath)) return null;
  return { buffer: fs.readFileSync(filePath), contentType: contentTypeFor(filePath) };
}

function deletePrivateFile(ref, folder) {
  if (!ref) return;

  if (ref.startsWith(PRIVATE_PREFIX)) {
    const id = ref.slice(PRIVATE_PREFIX.length);
    const publicId = id.slice(0, id.length - path.extname(id).length);
    cloudinary.uploader
      .destroy(publicId, { type: 'authenticated', resource_type: 'image' })
      .catch(() => {});
    return;
  }

  fs.unlink(path.join(PRIVATE_ROOT, folder, path.basename(ref)), () => {});
}

module.exports = {
  isCloudEnabled,
  storePublicFile,
  deleteStoredFile,
  storePrivateFile,
  readPrivateFile,
  deletePrivateFile,
};
