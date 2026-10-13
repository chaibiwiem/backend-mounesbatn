const { validationResult } = require('express-validator');
const db = require('../models');

const { City, Listing } = db;

// Liste publique (recherche, formulaire d'inscription prestataire...) :
// villes actives uniquement, triees comme configure par l'admin.
exports.getCities = async (req, res, next) => {
  try {
    const cities = await City.findAll({
      where: { isActive: true },
      order: [['sortOrder', 'ASC'], ['name', 'ASC']],
    });
    return res.json(cities);
  } catch (err) {
    return next(err);
  }
};

// Toutes les villes actives (activees dans l'admin, cf. CitiesTab.jsx), avec
// leur nombre de prestataires actifs - pour la section "Professionnels par
// zone" de la page d'accueil. Inclut les villes a 0 prestataire : reflete
// exactement le toggle admin plutot que de les masquer. `listings.city`
// etant une simple chaine (pas de FK, cf. models/City.js), le rapprochement
// se fait par egalite de nom.
exports.getCitiesWithCounts = async (req, res, next) => {
  try {
    const cities = await City.findAll({
      where: { isActive: true },
      order: [['sortOrder', 'ASC'], ['name', 'ASC']],
    });

    const counts = await Promise.all(
      cities.map((city) => Listing.count({ where: { city: city.name, status: 'active' } }))
    );

    const results = cities.map((city, index) => ({ id: city.id, name: city.name, count: counts[index] }));

    return res.json(results);
  } catch (err) {
    return next(err);
  }
};

// Toutes les villes (actives + inactives), pour l'onglet admin "Villes / Régions".
exports.getCitiesAdmin = async (req, res, next) => {
  try {
    const cities = await City.findAll({
      order: [['sortOrder', 'ASC'], ['name', 'ASC']],
    });
    return res.json(cities);
  } catch (err) {
    return next(err);
  }
};

exports.createCity = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { name, sortOrder } = req.body;

  try {
    const existing = await City.findOne({ where: { name } });
    if (existing) {
      return res.status(409).json({ message: 'Cette ville existe déjà.' });
    }

    const city = await City.create({ name, sortOrder: sortOrder ?? 0 });
    return res.status(201).json(city);
  } catch (err) {
    return next(err);
  }
};

exports.updateCity = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { name, sortOrder, isActive } = req.body;

  try {
    const city = await City.findByPk(req.params.id);
    if (!city) {
      return res.status(404).json({ message: 'Ville introuvable.' });
    }

    if (name !== undefined && name !== city.name) {
      const existing = await City.findOne({ where: { name } });
      if (existing) {
        return res.status(409).json({ message: 'Cette ville existe déjà.' });
      }
    }

    if (name !== undefined) city.name = name;
    if (sortOrder !== undefined) city.sortOrder = sortOrder;
    if (isActive !== undefined) city.isActive = isActive;
    await city.save();

    return res.json(city);
  } catch (err) {
    return next(err);
  }
};

exports.deleteCity = async (req, res, next) => {
  try {
    const city = await City.findByPk(req.params.id);
    if (!city) {
      return res.status(404).json({ message: 'Ville introuvable.' });
    }

    await city.destroy();
    return res.json({ message: 'Ville supprimée.' });
  } catch (err) {
    return next(err);
  }
};
