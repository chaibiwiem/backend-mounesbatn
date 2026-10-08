const db = require('../models');

const { Vehicle, VehicleOption, Listing } = db;

const PRICING_TYPES = ['per_day', 'flat'];

async function getOwnedVehicle(req, res) {
  const vehicle = await Vehicle.findByPk(req.params.id, {
    include: [{ model: Listing, as: 'listing' }],
  });
  if (!vehicle) {
    res.status(404).json({ message: 'Véhicule introuvable.' });
    return null;
  }
  if (vehicle.listing.userId !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ message: 'Accès interdit.' });
    return null;
  }
  return vehicle;
}

async function getOwnedOption(req, res) {
  const option = await VehicleOption.findByPk(req.params.id, {
    include: [{ model: Vehicle, as: 'vehicle', include: [{ model: Listing, as: 'listing' }] }],
  });
  if (!option) {
    res.status(404).json({ message: 'Option introuvable.' });
    return null;
  }
  if (option.vehicle.listing.userId !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ message: 'Accès interdit.' });
    return null;
  }
  return option;
}

// Ajoute une option supplementaire (2eme conducteur, GPS, siege bebe...) a un
// vehicule - exports.getVehicleOptions n'existe pas separement : toujours
// renvoyees avec le vehicule (cf. vehicleController.getListingVehicles).
exports.addOption = async (req, res, next) => {
  try {
    const vehicle = await getOwnedVehicle(req, res);
    if (!vehicle) return;

    const { name, price, pricingType, maxQuantity } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Nom de l'option requis." });
    }
    if (pricingType && !PRICING_TYPES.includes(pricingType)) {
      return res.status(400).json({ message: 'Type de tarification invalide.' });
    }

    const option = await VehicleOption.create({
      vehicleId: vehicle.id,
      name: name.trim(),
      price: price || 0,
      pricingType: pricingType || 'per_day',
      maxQuantity: maxQuantity || 1,
      isAvailable: true,
    });

    return res.status(201).json(option);
  } catch (err) {
    return next(err);
  }
};

exports.updateOption = async (req, res, next) => {
  try {
    const option = await getOwnedOption(req, res);
    if (!option) return;

    const { name, price, pricingType, maxQuantity } = req.body;
    if (pricingType !== undefined && pricingType && !PRICING_TYPES.includes(pricingType)) {
      return res.status(400).json({ message: 'Type de tarification invalide.' });
    }

    if (name !== undefined) option.name = name.trim();
    if (price !== undefined) option.price = price === '' ? 0 : price;
    if (pricingType !== undefined && pricingType) option.pricingType = pricingType;
    if (maxQuantity !== undefined) option.maxQuantity = maxQuantity === '' ? 1 : maxQuantity;

    await option.save();
    return res.json(option);
  } catch (err) {
    return next(err);
  }
};

// Retrait = soft delete (isAvailable=false), jamais de suppression
// definitive - les demandes passees restent tracees (LeadOption).
exports.deleteOption = async (req, res, next) => {
  try {
    const option = await getOwnedOption(req, res);
    if (!option) return;

    option.isAvailable = false;
    await option.save();

    return res.json({ message: 'Option retirée.' });
  } catch (err) {
    return next(err);
  }
};
