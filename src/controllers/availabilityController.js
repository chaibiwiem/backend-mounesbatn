const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const db = require('../models');
const { getProviderPlan } = require('../services/planService');
const { stayNights } = require('../utils/stay');

const { Availability, Listing, Booking, Vehicle, VehicleBooking } = db;

async function getOwnListing(req, res) {
  const listing = await Listing.findOne({ where: { userId: req.user.id } });
  if (!listing) {
    res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    return null;
  }
  return listing;
}

// Calendrier des disponibilites : option activable par plan (calendarEnabled,
// Parametres admin > Plans & Tarifs - desactivee pour Starter). La lecture
// publique (getAvailability) reste ouverte : seules les modifications par le
// prestataire sont bloquees.
async function ensureCalendarEnabled(req, res) {
  const { limits } = await getProviderPlan(req.user.id);
  if (!limits.calendarEnabled) {
    res.status(403).json({
      message: `Votre plan (${limits.label}) n'inclut pas le calendrier des disponibilités. Passez à un plan supérieur pour l'activer.`,
    });
    return false;
  }
  return true;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Toutes les dates (YYYY-MM-DD) couvertes par une periode depart/retour,
// bornes incluses - une location de plusieurs jours doit bloquer chaque jour
// traverse dans le calendrier, pas seulement le jour de depart.
function dateRangeStrings(start, end) {
  const dates = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    dates.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

// Les demandes de devis confirmees (bookings) bloquent automatiquement la
// date correspondante dans le calendrier : le prestataire n'a pas a la
// marquer manuellement non-disponible, et un booking confirme prime toujours
// sur une entree manuelle existante pour la meme date.
exports.getAvailability = async (req, res, next) => {
  try {
    const { id } = req.params;
    const availability = await Availability.findAll({
      where: { listingId: id },
      order: [['date', 'ASC']],
    });

    const confirmedBookings = await Booking.findAll({
      where: {
        listingId: id,
        status: { [Op.in]: ['confirmed', 'completed'] },
        eventDate: { [Op.ne]: null },
      },
      attributes: ['id', 'eventDate', 'checkInDate', 'checkOutDate'],
    });

    // Locations de vehicules (prestataires Transport) : chaque jour couvert
    // par une location active (hors annulee) bloque la date correspondante,
    // au meme titre qu'un booking generique confirme - voir
    // vehicleBookingController pour l'anti-chevauchement a la creation.
    const vehicleBookings = await VehicleBooking.findAll({
      where: { listingId: id, status: { [Op.ne]: 'cancelled' } },
      include: [{ model: Vehicle, as: 'vehicle', attributes: ['id', 'brand', 'model'] }],
      attributes: ['id', 'departureDatetime', 'returnDatetime'],
    });

    const byDate = new Map(availability.map((entry) => [entry.date, entry.toJSON()]));
    // Sejour "Maison d'hote" reserve : bloque chacune de ses nuits
    // [arrivee, depart[, pas seulement le jour d'arrivee.
    confirmedBookings.forEach((booking) => {
      const dates =
        booking.checkInDate && booking.checkOutDate
          ? stayNights(booking.checkInDate, booking.checkOutDate)
          : [booking.eventDate];
      dates.forEach((dateStr) => {
        byDate.set(dateStr, {
          id: `booking-${booking.id}-${dateStr}`,
          listingId: Number(id),
          date: dateStr,
          isAvailable: false,
          priceOverride: null,
          source: 'booking',
        });
      });
    });
    vehicleBookings.forEach((booking) => {
      dateRangeStrings(new Date(booking.departureDatetime), new Date(booking.returnDatetime)).forEach(
        (dateStr) => {
          byDate.set(dateStr, {
            id: `vehicle-booking-${booking.id}-${dateStr}`,
            listingId: Number(id),
            date: dateStr,
            isAvailable: false,
            priceOverride: null,
            source: 'booking',
            vehicle: booking.vehicle
              ? { id: booking.vehicle.id, brand: booking.vehicle.brand, model: booking.vehicle.model }
              : null,
          });
        }
      );
    });

    const merged = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
    return res.json(merged);
  } catch (err) {
    return next(err);
  }
};

exports.upsertAvailability = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;
    if (!(await ensureCalendarEnabled(req, res))) return;

    const { date, isAvailable, priceOverride } = req.body;
    if (!date) {
      return res.status(400).json({ message: 'Date requise.' });
    }

    const [entry, created] = await Availability.findOrCreate({
      where: { listingId: listing.id, date },
      defaults: { isAvailable, priceOverride },
    });

    if (!created) {
      if (isAvailable !== undefined) entry.isAvailable = isAvailable;
      if (priceOverride !== undefined) entry.priceOverride = priceOverride;
      await entry.save();
    }

    return res.status(created ? 201 : 200).json(entry);
  } catch (err) {
    return next(err);
  }
};

exports.deleteAvailability = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;
    if (!(await ensureCalendarEnabled(req, res))) return;

    const entry = await Availability.findOne({
      where: { id: req.params.id, listingId: listing.id },
    });
    if (!entry) {
      return res.status(404).json({ message: 'Entrée introuvable.' });
    }

    await entry.destroy();
    return res.json({ message: 'Disponibilité réinitialisée.' });
  } catch (err) {
    return next(err);
  }
};
