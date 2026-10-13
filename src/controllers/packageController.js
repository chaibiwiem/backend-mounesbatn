const { validationResult } = require('express-validator');
const db = require('../models');

const { Package, Listing } = db;

async function getOwnListing(req, res) {
  const listing = await Listing.findOne({ where: { userId: req.user.id } });
  if (!listing) {
    res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    return null;
  }
  return listing;
}

exports.createPackage = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const { name, description, price, priceType, duration } = req.body;
    const pkg = await Package.create({
      listingId: listing.id,
      name,
      description,
      price,
      priceType,
      duration,
    });

    return res.status(201).json(pkg);
  } catch (err) {
    return next(err);
  }
};

exports.updatePackage = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const pkg = await Package.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!pkg) {
      return res.status(404).json({ message: 'Package introuvable.' });
    }

    const { name, description, price, priceType, duration } = req.body;
    if (name !== undefined) pkg.name = name;
    if (description !== undefined) pkg.description = description;
    if (price !== undefined) pkg.price = price;
    if (priceType !== undefined) pkg.priceType = priceType;
    if (duration !== undefined) pkg.duration = duration;
    await pkg.save();

    return res.json(pkg);
  } catch (err) {
    return next(err);
  }
};

exports.deletePackage = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const pkg = await Package.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!pkg) {
      return res.status(404).json({ message: 'Package introuvable.' });
    }

    await pkg.destroy();
    return res.json({ message: 'Package supprimé.' });
  } catch (err) {
    return next(err);
  }
};
