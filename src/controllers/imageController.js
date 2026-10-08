const db = require('../models');
const { getProviderPlan } = require('../services/planService');

const { Image, Listing } = db;

async function getOwnListing(req, res) {
  const listing = await Listing.findOne({ where: { userId: req.user.id } });
  if (!listing) {
    res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    return null;
  }
  return listing;
}

exports.uploadImage = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const { limits } = await getProviderPlan(req.user.id);
    const currentCount = await Image.count({ where: { listingId: listing.id } });
    if (currentCount >= limits.maxPhotos) {
      return res.status(400).json({
        message: `Votre plan (${limits.label}) autorise au maximum ${limits.maxPhotos} photos. Passez à un plan supérieur pour en ajouter davantage.`,
      });
    }

    const image = await Image.create({
      listingId: listing.id,
      url: req.uploadedFile.url,
      isPrimary: currentCount === 0,
      sortOrder: currentCount,
    });

    return res.status(201).json(image);
  } catch (err) {
    return next(err);
  }
};

exports.deleteImage = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const image = await Image.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!image) {
      return res.status(404).json({ message: 'Photo introuvable.' });
    }

    await image.destroy();
    return res.json({ message: 'Photo supprimée.' });
  } catch (err) {
    return next(err);
  }
};

exports.setPrimaryImage = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const image = await Image.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!image) {
      return res.status(404).json({ message: 'Photo introuvable.' });
    }

    await Image.update({ isPrimary: false }, { where: { listingId: listing.id } });
    image.isPrimary = true;
    await image.save();

    return res.json(image);
  } catch (err) {
    return next(err);
  }
};

exports.reorderImages = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ message: 'Ordre invalide.' });
    }

    const images = await Image.findAll({ where: { listingId: listing.id } });
    const validIds = new Set(images.map((img) => img.id));
    if (order.length !== images.length || !order.every((id) => validIds.has(id))) {
      return res.status(400).json({ message: 'Ordre invalide.' });
    }

    await Promise.all(
      order.map((id, index) => Image.update({ sortOrder: index }, { where: { id } }))
    );

    return res.json({ message: 'Ordre mis à jour.' });
  } catch (err) {
    return next(err);
  }
};
