const db = require('../models');
const { persistOptionalImage, replaceStoredFile } = require('../middleware/upload');

const { Vehicle, VehicleDecoration, Listing } = db;

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

async function getOwnedDecoration(req, res) {
  const decoration = await VehicleDecoration.findByPk(req.params.id, {
    include: [{ model: Vehicle, as: 'vehicle', include: [{ model: Listing, as: 'listing' }] }],
  });
  if (!decoration) {
    res.status(404).json({ message: 'Modèle de décoration introuvable.' });
    return null;
  }
  if (decoration.vehicle.listing.userId !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ message: 'Accès interdit.' });
    return null;
  }
  return decoration;
}

// Ajoute un modele de decoration (photo/nom/prix) a un vehicule -
// exports.getVehicleDecorations n'existe pas separement : ils sont toujours
// renvoyes avec le vehicule (cf. vehicleController.getListingVehicles).
exports.addDecoration = async (req, res, next) => {
  try {
    const vehicle = await getOwnedVehicle(req, res);
    if (!vehicle) return;

    const { name, description, price } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Nom du modèle requis.' });
    }

    const image = await persistOptionalImage(req.file, res);
    if (image.error) return;

    const decoration = await VehicleDecoration.create({
      vehicleId: vehicle.id,
      name: name.trim(),
      description: description || null,
      price: price || null,
      imageUrl: image.imageUrl ?? null,
      isAvailable: true,
    });

    return res.status(201).json(decoration);
  } catch (err) {
    return next(err);
  }
};

exports.updateDecoration = async (req, res, next) => {
  try {
    const decoration = await getOwnedDecoration(req, res);
    if (!decoration) return;

    const image = await persistOptionalImage(req.file, res);
    if (image.error) return;

    const { name, description, price } = req.body;
    if (name !== undefined) decoration.name = name.trim();
    if (description !== undefined) decoration.description = description || null;
    if (price !== undefined) decoration.price = price === '' ? null : price;

    replaceStoredFile(decoration, 'imageUrl', image.imageUrl);

    await decoration.save();
    return res.json(decoration);
  } catch (err) {
    return next(err);
  }
};

// Retrait = soft delete (isAvailable=false), jamais de suppression
// definitive - les demandes passees restent tracees (Lead.decorationId).
exports.deleteDecoration = async (req, res, next) => {
  try {
    const decoration = await getOwnedDecoration(req, res);
    if (!decoration) return;

    decoration.isAvailable = false;
    await decoration.save();

    return res.json({ message: 'Modèle de décoration retiré.' });
  } catch (err) {
    return next(err);
  }
};
