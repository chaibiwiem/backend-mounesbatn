const db = require('../models');
const { persistOptionalImage, replaceStoredFile } = require('../middleware/upload');
const { isTransportListing } = require('../services/transportService');
const { getProviderPlan } = require('../services/planService');

const { Listing, Vehicle, VehicleDecoration, VehicleOption } = db;

const VEHICLE_TYPES = ['voiture', 'bus', 'minibus'];
const EDITABLE_VEHICLE_FIELDS = [
  'type',
  'brand',
  'model',
  'year',
  'seats',
  'doors',
  'luggage',
  'transmission',
  'pricePerDay',
  'pricePerHour',
  'withDriver',
  'airConditioned',
  'hasDecoration',
  'perksTitle',
  'description',
];
// Champs numeriques : une chaine vide envoyee depuis le formulaire (tarif
// efface) doit devenir NULL, jamais 0 - une colonne DECIMAL/INT MySQL
// coercerait silencieusement '' en 0 sinon (voir bug "0.00 DT/h" affiche).
const NUMERIC_VEHICLE_FIELDS = ['year', 'seats', 'doors', 'luggage', 'pricePerDay', 'pricePerHour'];

// Les modeles de decoration disponibles (VehicleDecoration.decorations) sont
// toujours inclus avec un vehicule - le client en choisit un dans un popup
// dedie (DecorationPickerModal cote front), pas un simple booleen avec/sans.
const DECORATIONS_INCLUDE = {
  model: VehicleDecoration,
  as: 'decorations',
  where: { isAvailable: true },
  required: false,
};

// Options supplementaires disponibles (2eme conducteur, GPS, siege bebe...) :
// toujours incluses avec un vehicule, le client choisit ses options (et leur
// quantite) lors de sa demande de location - voir leadController.createLead.
const OPTIONS_INCLUDE = {
  model: VehicleOption,
  as: 'options',
  where: { isAvailable: true },
  required: false,
};

function toBool(value) {
  return value === true || value === 'true';
}

async function getOwnListing(req, res) {
  const listing = await Listing.findByPk(req.params.id);
  if (!listing) {
    res.status(404).json({ message: 'Prestataire introuvable.' });
    return null;
  }
  if (listing.userId !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ message: 'Accès interdit.' });
    return null;
  }
  return listing;
}

// Public (fiche prestataire) : uniquement les vehicules actifs de la flotte.
exports.getListingVehicles = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }

    const vehicles = await Vehicle.findAll({
      where: { listingId: listing.id, isAvailable: true },
      include: [DECORATIONS_INCLUDE, OPTIONS_INCLUDE],
      order: [['createdAt', 'ASC']],
    });

    return res.json(vehicles);
  } catch (err) {
    return next(err);
  }
};

exports.addVehicle = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    if (!(await isTransportListing(listing))) {
      return res.status(403).json({
        message: 'La gestion de flotte est réservée aux prestataires de la catégorie Transport.',
      });
    }

    // Limite par plan (Parametres admin > Plans & Tarifs), meme principe que
    // imageController.uploadImage pour maxPhotos - voitures et bus comptent
    // ensemble dans le meme quota "maxVehicles" (sous-categorie Transport).
    const { limits } = await getProviderPlan(listing.userId);
    const vehicleCount = await Vehicle.count({ where: { listingId: listing.id } });
    if (vehicleCount >= limits.maxVehicles) {
      return res.status(400).json({
        message: `Votre plan (${limits.label}) autorise au maximum ${limits.maxVehicles} véhicule(s). Passez à un plan supérieur pour en ajouter davantage.`,
      });
    }

    const {
      type,
      brand,
      model,
      year,
      seats,
      doors,
      luggage,
      transmission,
      pricePerDay,
      pricePerHour,
      withDriver,
      airConditioned,
      hasDecoration,
      perksTitle,
      description,
    } = req.body;

    if (!VEHICLE_TYPES.includes(type)) {
      return res.status(400).json({ message: 'Type de véhicule invalide.' });
    }
    if (transmission && !['manuelle', 'automatique'].includes(transmission)) {
      return res.status(400).json({ message: 'Boîte de vitesses invalide.' });
    }

    const image = await persistOptionalImage(req.file, res);
    if (image.error) return;

    const vehicle = await Vehicle.create({
      listingId: listing.id,
      type,
      brand: brand || null,
      model: model || null,
      year: year || null,
      seats: seats || null,
      doors: doors || null,
      luggage: luggage || null,
      transmission: transmission || null,
      pricePerDay: pricePerDay || null,
      pricePerHour: pricePerHour || null,
      withDriver: toBool(withDriver),
      airConditioned: toBool(airConditioned),
      hasDecoration: toBool(hasDecoration),
      perksTitle: perksTitle || null,
      description: description || null,
      imageUrl: image.imageUrl ?? null,
      isAvailable: true,
    });

    return res.status(201).json(vehicle);
  } catch (err) {
    return next(err);
  }
};

exports.updateVehicle = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findByPk(req.params.id, {
      include: [{ model: Listing, as: 'listing' }],
    });
    if (!vehicle) {
      return res.status(404).json({ message: 'Véhicule introuvable.' });
    }
    if (vehicle.listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    if (req.body.type !== undefined && !VEHICLE_TYPES.includes(req.body.type)) {
      return res.status(400).json({ message: 'Type de véhicule invalide.' });
    }

    const image = await persistOptionalImage(req.file, res);
    if (image.error) return;

    EDITABLE_VEHICLE_FIELDS.forEach((field) => {
      if (req.body[field] === undefined) return;
      if (field === 'withDriver' || field === 'airConditioned' || field === 'hasDecoration') {
        vehicle[field] = toBool(req.body[field]);
      } else if (NUMERIC_VEHICLE_FIELDS.includes(field) && req.body[field] === '') {
        vehicle[field] = null;
      } else {
        vehicle[field] = req.body[field];
      }
    });

    replaceStoredFile(vehicle, 'imageUrl', image.imageUrl);

    await vehicle.save();
    return res.json(vehicle);
  } catch (err) {
    return next(err);
  }
};

// Retrait de la flotte = soft delete (isAvailable=false), jamais de
// suppression definitive - les locations passees restent tracees.
exports.deleteVehicle = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findByPk(req.params.id, {
      include: [{ model: Listing, as: 'listing' }],
    });
    if (!vehicle) {
      return res.status(404).json({ message: 'Véhicule introuvable.' });
    }
    if (vehicle.listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    vehicle.isAvailable = false;
    await vehicle.save();

    return res.json({ message: 'Véhicule retiré de la flotte.' });
  } catch (err) {
    return next(err);
  }
};
