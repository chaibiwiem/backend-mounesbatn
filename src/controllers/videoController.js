const fs = require('fs');
const path = require('path');
const { validationResult } = require('express-validator');
const db = require('../models');
const { parseVideoUrl } = require('../utils/videoEmbed');
const { getProviderPlan } = require('../services/planService');
const {
  VIDEO_UPLOAD_DIR,
  UPLOAD_DIR,
  persistVideoBuffer,
  persistBuffer,
  detectRealMimeType,
} = require('../middleware/upload');

const { Video, Listing } = db;

async function getOwnListing(req, res) {
  const listing = await Listing.findOne({ where: { userId: req.user.id } });
  if (!listing) {
    res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    return null;
  }
  return listing;
}

// Limite par plan (Parametres admin > Plans & Tarifs), meme principe que
// imageController.uploadImage pour maxPhotos - plus le quota global fixe
// d'avant (5 pour tous), qui ne recompensait pas les plans payants.
async function checkVideoQuota(listing, res) {
  const { limits } = await getProviderPlan(listing.userId);
  const currentCount = await Video.count({ where: { listingId: listing.id } });
  if (currentCount >= limits.maxVideos) {
    res.status(400).json({
      message: `Votre plan (${limits.label}) autorise au maximum ${limits.maxVideos} vidéos. Passez à un plan supérieur pour en ajouter davantage.`,
    });
    return null;
  }
  return currentCount;
}

// Vignette personnalisee (JPG/PNG) fournie par le prestataire : prioritaire
// sur toute vignette derivee automatiquement (ex. YouTube). Meme verification
// que les photos de galerie (magic bytes, jamais l'extension declaree).
function persistCustomThumbnail(file, res) {
  if (!file) return { thumbnailUrl: undefined, error: null };

  const realMimeType = detectRealMimeType(file.buffer);
  if (!realMimeType) {
    res.status(400).json({ message: 'Vignette invalide. Utilisez JPG ou PNG.' });
    return { thumbnailUrl: undefined, error: true };
  }

  const filename = persistBuffer(file.buffer, UPLOAD_DIR);
  return { thumbnailUrl: `/uploads/listings/${filename}`, error: null };
}

exports.getListingVideos = async (req, res, next) => {
  try {
    const videos = await Video.findAll({
      where: { listingId: req.params.id },
      order: [['sortOrder', 'ASC']],
    });
    return res.json(videos);
  } catch (err) {
    return next(err);
  }
};

// Ajout par lien externe (YouTube/Vimeo) : pas de stockage cote serveur pour
// la video elle-meme. Vignette personnalisee optionnelle (champ 'thumbnail').
exports.addVideoLink = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const { url, title } = req.body;

    const parsed = parseVideoUrl(url);
    if (!parsed) {
      return res.status(400).json({
        message: 'Lien vidéo invalide. Utilisez un lien YouTube ou Vimeo public.',
      });
    }

    const currentCount = await checkVideoQuota(listing, res);
    if (currentCount === null) return;

    const customThumbnail = persistCustomThumbnail(req.files?.thumbnail?.[0], res);
    if (customThumbnail.error) return;

    const video = await Video.create({
      listingId: listing.id,
      type: 'link',
      url,
      embedUrl: parsed.embedUrl,
      thumbnailUrl: customThumbnail.thumbnailUrl ?? parsed.thumbnailUrl,
      title: title || null,
      sortOrder: currentCount,
    });

    return res.status(201).json(video);
  } catch (err) {
    return next(err);
  }
};

// Upload direct d'un fichier MP4/WebM (verifie par magic bytes, jamais
// l'extension declaree). Vignette personnalisee optionnelle (champ
// 'thumbnail') : sans elle, un upload n'a aucune vignette (pas d'extraction
// de frame video cote serveur).
exports.uploadVideoFile = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const videoFile = req.files?.video?.[0];
    if (!videoFile) {
      return res.status(400).json({ message: 'Aucun fichier vidéo reçu.' });
    }

    const currentCount = await checkVideoQuota(listing, res);
    if (currentCount === null) return;

    const filename = persistVideoBuffer(videoFile.buffer);
    if (!filename) {
      return res
        .status(400)
        .json({ message: 'Format de fichier non supporté. Utilisez MP4 ou WebM.' });
    }

    const customThumbnail = persistCustomThumbnail(req.files?.thumbnail?.[0], res);
    if (customThumbnail.error) return;

    const video = await Video.create({
      listingId: listing.id,
      type: 'upload',
      url: `/uploads/videos/${filename}`,
      embedUrl: null,
      thumbnailUrl: customThumbnail.thumbnailUrl ?? null,
      title: req.body.title || null,
      sortOrder: currentCount,
    });

    return res.status(201).json(video);
  } catch (err) {
    return next(err);
  }
};

// Modifie le titre et/ou la vignette d'une video existante — permet d'ajouter
// une belle image de couverture apres coup a une video deja ajoutee sans
// vignette (lien Vimeo ou upload), sans avoir a la supprimer/recreer.
exports.updateVideo = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const video = await Video.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!video) {
      return res.status(404).json({ message: 'Vidéo introuvable.' });
    }

    const thumbnailFile = req.files?.thumbnail?.[0];
    if (thumbnailFile) {
      const customThumbnail = persistCustomThumbnail(thumbnailFile, res);
      if (customThumbnail.error) return;

      const previousThumbnail = video.thumbnailUrl;
      video.thumbnailUrl = customThumbnail.thumbnailUrl;

      if (previousThumbnail?.startsWith('/uploads/listings/')) {
        const previousPath = path.join(UPLOAD_DIR, path.basename(previousThumbnail));
        fs.unlink(previousPath, () => {});
      }
    }

    if (req.body.title !== undefined) {
      video.title = req.body.title || null;
    }

    await video.save();
    return res.json(video);
  } catch (err) {
    return next(err);
  }
};

exports.deleteVideo = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const video = await Video.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!video) {
      return res.status(404).json({ message: 'Vidéo introuvable.' });
    }

    if (video.type === 'upload') {
      const filePath = path.join(VIDEO_UPLOAD_DIR, path.basename(video.url));
      fs.unlink(filePath, () => {}); // best-effort, non bloquant
    }
    if (video.thumbnailUrl?.startsWith('/uploads/listings/')) {
      const thumbnailPath = path.join(UPLOAD_DIR, path.basename(video.thumbnailUrl));
      fs.unlink(thumbnailPath, () => {});
    }

    await video.destroy();
    return res.json({ message: 'Vidéo supprimée.' });
  } catch (err) {
    return next(err);
  }
};
