const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const db = require('../models');
const { persistOptionalImage, replaceStoredFile } = require('../middleware/upload');
const { getProviderPlan } = require('../services/planService');

const { Listing, ProviderEvent } = db;

async function getOwnedListing(req, res) {
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

async function getOwnedEvent(req, res) {
  const event = await ProviderEvent.findByPk(req.params.id, {
    include: [{ model: Listing, as: 'listing' }],
  });
  if (!event) {
    res.status(404).json({ message: 'Événement introuvable.' });
    return null;
  }
  if (event.listing.userId !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ message: 'Accès interdit.' });
    return null;
  }
  return event;
}

// Espace prestataire : tous ses evenements (a venir + passes, publies +
// brouillons) - le tri a venir/passe se fait cote front (memes donnees).
exports.getListingEvents = async (req, res, next) => {
  try {
    const listing = await getOwnedListing(req, res);
    if (!listing) return;

    const events = await ProviderEvent.findAll({
      where: { listingId: listing.id },
      order: [['eventDate', 'DESC']],
    });

    return res.json(events);
  } catch (err) {
    return next(err);
  }
};

// Fiche publique : uniquement les evenements publies et a venir (>= aujourd'hui).
exports.getPublicListingEvents = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const events = await ProviderEvent.findAll({
      where: {
        listingId: listing.id,
        isPublished: true,
        eventDate: { [Op.gte]: today },
      },
      order: [['eventDate', 'ASC']],
    });

    return res.json(events);
  } catch (err) {
    return next(err);
  }
};

exports.createEvent = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnedListing(req, res);
    if (!listing) return;

    const { limits } = await getProviderPlan(listing.userId);
    if (!limits.eventsEnabled) {
      return res.status(403).json({
        message: `Votre plan (${limits.label}) ne permet pas de créer des événements. Passez à un plan supérieur pour activer cette fonctionnalité.`,
      });
    }

    const { title, description, type, eventDate, startTime, endTime, location, isPublished } = req.body;

    const image = persistOptionalImage(req.file, res);
    if (image.error) return;

    const event = await ProviderEvent.create({
      listingId: listing.id,
      title: title.trim(),
      description: description || null,
      type: type || 'autre',
      eventDate,
      startTime: startTime || null,
      endTime: endTime || null,
      location: location || listing.address || null,
      imageUrl: image.imageUrl ?? null,
      isPublished: isPublished === undefined ? false : Boolean(isPublished),
    });

    return res.status(201).json(event);
  } catch (err) {
    return next(err);
  }
};

exports.updateEvent = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const event = await getOwnedEvent(req, res);
    if (!event) return;

    const { title, description, type, eventDate, startTime, endTime, location, isPublished } = req.body;

    const image = persistOptionalImage(req.file, res);
    if (image.error) return;

    if (title !== undefined) event.title = title.trim();
    if (description !== undefined) event.description = description || null;
    if (type !== undefined) event.type = type;
    if (eventDate !== undefined) event.eventDate = eventDate;
    if (startTime !== undefined) event.startTime = startTime || null;
    if (endTime !== undefined) event.endTime = endTime || null;
    if (location !== undefined) event.location = location || null;
    if (isPublished !== undefined) event.isPublished = Boolean(isPublished);

    replaceStoredFile(event, 'imageUrl', image.imageUrl);

    await event.save();
    return res.json(event);
  } catch (err) {
    return next(err);
  }
};

exports.publishEvent = async (req, res, next) => {
  try {
    const event = await getOwnedEvent(req, res);
    if (!event) return;

    // Accepte un statut explicite (isPublished) ou, a defaut, bascule la
    // valeur courante - couvre le bouton "Publier"/"Depublier" du dashboard.
    event.isPublished = req.body.isPublished === undefined ? !event.isPublished : Boolean(req.body.isPublished);
    await event.save();

    return res.json(event);
  } catch (err) {
    return next(err);
  }
};

// Suppression = soft delete (paranoid Sequelize, deletedAt) - jamais
// definitive, coherent avec Listing.deletedAt (CLAUDE.md).
exports.deleteEvent = async (req, res, next) => {
  try {
    const event = await getOwnedEvent(req, res);
    if (!event) return;

    await event.destroy();
    return res.json({ message: 'Événement supprimé.' });
  } catch (err) {
    return next(err);
  }
};
