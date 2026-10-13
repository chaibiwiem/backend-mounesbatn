const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;

// Stockage des fichiers envoyes (photos, videos, icones, carte CIN).
// - Cloudinary des que CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET sont definis
//   (production sur Vercel, dont le disque est en lecture seule et ephemere) ;
// - sinon disque local (developpement, tests), comme avant.
// Le contenu est toujours verifie AVANT d'arriver ici (magic bytes, SVG
// assaini - middleware/upload.js) ; le nom d'origine n'est jamais conserve.

const UPLOADS_ROOT = path.join(__dirname, '../../uploads');
const LEGAL_DIR = path.join(__dirname, '../../private-uploads/legal');
const CLOUD_FOLDER = 'mounesba';
// Reference d'une carte CIN stockee chez Cloudinary (privee, jamais d'URL
// publique) : "cloudinary:<public_id>.<format>".
const LEGAL_CLOUD_PREFIX = 'cloudinary:';

let configured = false;
function useCloudinary() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return false;
  if (!configured) {
    cloudinary.config({
      cloud_name: CLOUDINARY_CLOUD_NAME,
      api_key: CLOUDINARY_API_KEY,
      api_secret: CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
  return true;
}

const randomName = () => crypto.randomBytes(16).toString('hex');

function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (err, result) => (err ? reject(err) : resolve(result)))
      .end(buffer);
  });
}

// Enregistre un fichier public (servi tel quel) et renvoie son URL :
// "/uploads/<folder>/<nom>" en local, URL https Cloudinary sinon.
// resourceType : 'image' (photos, SVG) ou 'video'.
async function saveFile(buffer, { folder, extension, resourceType = 'image' }) {
  const name = randomName();
  if (!useCloudinary()) {
    const dir = path.join(UPLOADS_ROOT, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}${extension}`), buffer);
    return `/uploads/${folder}/${name}${extension}`;
  }
  const result = await uploadBuffer(buffer, {
    folder: `${CLOUD_FOLDER}/${folder}`,
    public_id: name,
    resource_type: resourceType,
    format: extension.replace('.', ''),
    overwrite: false,
  });
  return result.secure_url;
}

// Extrait type de ressource + public_id d'une URL de livraison Cloudinary
// (https://res.cloudinary.com/<cloud>/<type>/upload/v123/<public_id>.<ext>).
function parseCloudinaryUrl(url) {
  const match = /^https:\/\/res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i.exec(url);
  return match ? { resourceType: match[1], publicId: match[2] } : null;
}

// Suppression best-effort (jamais bloquante) d'un fichier public, quel que
// soit l'endroit ou il est stocke. Ignore toute URL externe (YouTube...).
function removeFile(url) {
  if (typeof url !== 'string' || !url) return;
  if (url.startsWith('/uploads/')) {
    // dossier + basename : aucun "../" ne peut sortir de uploads/.
    const [, , folder] = url.split('/');
    fs.unlink(path.join(UPLOADS_ROOT, path.basename(folder), path.basename(url)), () => {});
    return;
  }
  const cloud = parseCloudinaryUrl(url);
  if (cloud && useCloudinary()) {
    cloudinary.uploader
      .destroy(cloud.publicId, { resource_type: cloud.resourceType, invalidate: true })
      .catch((err) => console.warn('Suppression Cloudinary impossible :', err.message));
  }
}

// --- Carte CIN (document legal sensible, CLAUDE.md) -------------------------
// Jamais publique : dossier private-uploads en local, ressource
// "authenticated" chez Cloudinary (lisible seulement via une URL signee
// generee cote serveur, voir readLegalFile).

async function saveLegalFile(buffer, extension) {
  const name = randomName();
  if (!useCloudinary()) {
    fs.mkdirSync(LEGAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(LEGAL_DIR, `${name}${extension}`), buffer);
    return `${name}${extension}`;
  }
  const result = await uploadBuffer(buffer, {
    folder: `${CLOUD_FOLDER}/legal`,
    public_id: name,
    resource_type: 'image',
    type: 'authenticated',
    format: extension.replace('.', ''),
  });
  return `${LEGAL_CLOUD_PREFIX}${result.public_id}.${result.format}`;
}

function parseLegalRef(ref) {
  const value = ref.slice(LEGAL_CLOUD_PREFIX.length);
  const dot = value.lastIndexOf('.');
  return { publicId: value.slice(0, dot), format: value.slice(dot + 1) };
}

// Contenu d'une carte CIN, ou null si introuvable.
async function readLegalFile(ref) {
  if (!ref) return null;
  if (ref.startsWith(LEGAL_CLOUD_PREFIX)) {
    if (!useCloudinary()) return null;
    const { publicId, format } = parseLegalRef(ref);
    const signedUrl = cloudinary.url(publicId, {
      type: 'authenticated',
      resource_type: 'image',
      sign_url: true,
      format,
    });
    const response = await fetch(signedUrl);
    if (!response.ok) return null;
    return { buffer: Buffer.from(await response.arrayBuffer()), extension: `.${format}` };
  }
  const filePath = path.join(LEGAL_DIR, path.basename(ref));
  if (!fs.existsSync(filePath)) return null;
  return { buffer: fs.readFileSync(filePath), extension: path.extname(filePath) };
}

function removeLegalFile(ref) {
  if (!ref) return;
  if (ref.startsWith(LEGAL_CLOUD_PREFIX)) {
    if (!useCloudinary()) return;
    const { publicId } = parseLegalRef(ref);
    cloudinary.uploader
      .destroy(publicId, { resource_type: 'image', type: 'authenticated', invalidate: true })
      .catch((err) => console.warn('Suppression Cloudinary impossible :', err.message));
    return;
  }
  fs.unlink(path.join(LEGAL_DIR, path.basename(ref)), () => {});
}

// Contenu d'une image publique (logo sur les PDF) : lecture disque en local,
// telechargement sinon. null si introuvable - jamais bloquant.
async function readPublicFile(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    if (url.startsWith('/uploads/')) {
      const [, , folder] = url.split('/');
      const filePath = path.join(UPLOADS_ROOT, path.basename(folder), path.basename(url));
      return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    }
    if (parseCloudinaryUrl(url)) {
      const response = await fetch(url);
      return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
    }
  } catch {
    // Fichier illisible : l'appelant continue sans.
  }
  return null;
}

module.exports = {
  saveFile,
  removeFile,
  saveLegalFile,
  readLegalFile,
  removeLegalFile,
  readPublicFile,
  useCloudinary,
};
