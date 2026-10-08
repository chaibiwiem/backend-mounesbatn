const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const db = require('../models');
const connectionFeeService = require('../services/connectionFeeService');
const crmService = require('../services/crmService');

const { Vehicle, Listing, VehicleBooking, Client, Lead, VehicleDecoration, VehicleOption, LeadOption } = db;

const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];
const PAYMENT_METHODS = ['cash', 'rib'];

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

// Public (fiche prestataire / formulaire de demande) : uniquement les periodes
// deja reservees pour ce vehicule (departure/return), aucune donnee client -
// permet d'afficher au client les dates indisponibles et de bloquer cote
// front une demande qui chevaucherait une location active.
exports.getPublicReservedPeriods = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findByPk(req.params.id);
    if (!vehicle) {
      return res.status(404).json({ message: 'Véhicule introuvable.' });
    }

    // Seules les locations pas encore terminees (retour dans le futur) :
    // une location passee rend automatiquement le vehicule disponible et ne
    // doit plus etre affichee au client.
    const bookings = await VehicleBooking.findAll({
      where: {
        vehicleId: vehicle.id,
        status: { [Op.ne]: 'cancelled' },
        returnDatetime: { [Op.gt]: new Date() },
      },
      attributes: ['departureDatetime', 'returnDatetime'],
      order: [['departureDatetime', 'ASC']],
    });

    return res.json(bookings);
  } catch (err) {
    return next(err);
  }
};

// Vue "Reservations" du tableau de bord prestataire, cote Transport : toutes
// les locations (tous vehicules confondus) de la fiche, avec les memes champs
// que la demande de location d'origine (passagers/chauffeur/decoration, via
// le lead associe) - pas seulement Date/Montant comme une reservation
// generique (voir bookingController.getListingBookings).
exports.getListingVehicleBookings = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }
    if (listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    const bookings = await VehicleBooking.findAll({
      where: { listingId: listing.id },
      include: [
        { model: Client, as: 'client' },
        { model: Vehicle, as: 'vehicle', attributes: ['id', 'brand', 'model', 'type'] },
        {
          model: Lead,
          as: 'lead',
          attributes: ['id', 'firstName', 'lastName', 'email', 'phone', 'passengers', 'withDriver', 'pickupLocation'],
          include: [
            { model: VehicleDecoration, as: 'decoration', attributes: ['id', 'name', 'price'] },
            {
              model: LeadOption,
              as: 'selectedOptions',
              include: [{ model: VehicleOption, as: 'option', attributes: ['id', 'name', 'price', 'pricingType'] }],
            },
          ],
        },
      ],
      order: [['departureDatetime', 'DESC']],
    });

    return res.json(bookings);
  } catch (err) {
    return next(err);
  }
};

exports.getVehicleBookings = async (req, res, next) => {
  try {
    const vehicle = await getOwnedVehicle(req, res);
    if (!vehicle) return;

    const bookings = await VehicleBooking.findAll({
      where: { vehicleId: vehicle.id },
      include: [
        { model: Client, as: 'client' },
        { model: Lead, as: 'lead', attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
      ],
      order: [['departureDatetime', 'DESC']],
    });

    return res.json(bookings);
  } catch (err) {
    return next(err);
  }
};

// Enregistrement d'une location conclue en direct (CLAUDE.md - aucun
// paiement en ligne, montant declaratif) : meme logique que bookingController
// (client CRM existant/nouveau/derive du lead, lead -> converti), avec en
// plus la verification anti-chevauchement propre a un vehicule reutilisable.
exports.createVehicleBooking = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const vehicle = await getOwnedVehicle(req, res);
    if (!vehicle) return;

    const {
      leadId,
      clientId,
      clientName,
      clientEmail,
      clientPhone,
      departureDatetime,
      returnDatetime,
      totalPrice,
      deposit,
      paymentMethod,
      status,
      notes,
    } = req.body;

    if (new Date(returnDatetime) <= new Date(departureDatetime)) {
      return res
        .status(400)
        .json({ message: 'La date de retour doit être postérieure à la date de départ.' });
    }

    const finalStatus = status || 'confirmed';
    if (!BOOKING_STATUSES.includes(finalStatus)) {
      return res.status(400).json({ message: 'Statut invalide.' });
    }
    if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ message: 'Mode de règlement invalide.' });
    }

    // Anti-chevauchement : aucune location active (hors annulee) de ce
    // vehicule ne doit croiser la periode demandee.
    const overlapping = await VehicleBooking.findOne({
      where: {
        vehicleId: vehicle.id,
        status: { [Op.ne]: 'cancelled' },
        departureDatetime: { [Op.lt]: returnDatetime },
        returnDatetime: { [Op.gt]: departureDatetime },
      },
    });
    if (overlapping) {
      return res.status(409).json({ message: 'Ce véhicule est déjà loué sur cette période.' });
    }

    let lead = null;
    if (leadId) {
      lead = await Lead.findOne({ where: { id: leadId, listingId: vehicle.listingId } });
      if (!lead) {
        return res.status(404).json({ message: 'Demande introuvable.' });
      }
    }

    let client = null;
    if (clientId) {
      client = await Client.findOne({ where: { id: clientId, listingId: vehicle.listingId } });
      if (!client) {
        return res.status(404).json({ message: 'Client introuvable.' });
      }
    } else if (clientName && clientName.trim()) {
      if (clientEmail) {
        [client] = await Client.findOrCreate({
          where: { listingId: vehicle.listingId, email: clientEmail },
          defaults: {
            listingId: vehicle.listingId,
            name: clientName.trim(),
            email: clientEmail,
            phone: clientPhone || null,
          },
        });
      } else {
        client = await Client.create({
          listingId: vehicle.listingId,
          name: clientName.trim(),
          phone: clientPhone || null,
        });
      }
    } else if (lead) {
      client = await crmService.findOrCreateClientForLead(lead, vehicle.listing);
    } else {
      return res.status(400).json({
        message: 'Sélectionnez un client existant ou renseignez au moins son nom.',
      });
    }

    const booking = await VehicleBooking.create({
      vehicleId: vehicle.id,
      listingId: vehicle.listingId,
      clientId: client.id,
      leadId: lead ? lead.id : null,
      departureDatetime,
      returnDatetime,
      totalPrice: totalPrice || null,
      deposit: deposit || null,
      paymentMethod: paymentMethod || null,
      status: finalStatus,
      notes: notes || null,
    });

    if (finalStatus !== 'cancelled') {
      await crmService.registerConvertedEvent(client);
    }
    // Montant total + acompte déclarés (CRM) : recalculés à partir des
    // locations non annulées du client, voir crmService.
    await crmService.recalculateClientFinancials(client);

    if (lead && lead.status !== 'converted') {
      if (!lead.answeredAt) lead.answeredAt = new Date();
      lead.status = 'converted';
      await lead.save();
    }
    // Frais de mise en relation (M13) : meme declaration automatique qu'une
    // reservation classique (montant de la location = contrat).
    if (lead && finalStatus !== 'cancelled') {
      await connectionFeeService.autoDeclareFee(lead, vehicle.listing, {
        eventDate: booking.departureDatetime ? new Date(booking.departureDatetime).toISOString().slice(0, 10) : null,
        declaredAmount: booking.totalPrice,
      });
    }

    const created = await VehicleBooking.findByPk(booking.id, {
      include: [
        { model: Client, as: 'client' },
        { model: Lead, as: 'lead', attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
      ],
    });

    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
};

// Edition complete d'une location (dates, montant, reglement, notes) depuis
// l'onglet "Reservations" du tableau de bord - contrairement a
// updateVehicleBookingStatus (statut seul), permet de corriger une periode
// ou un montant sans annuler/recreer la reservation.
exports.updateVehicleBooking = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const booking = await VehicleBooking.findByPk(req.params.id, {
      include: [{ model: Listing, as: 'listing' }],
    });
    if (!booking) {
      return res.status(404).json({ message: 'Location introuvable.' });
    }
    if (booking.listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    const { departureDatetime, returnDatetime, totalPrice, deposit, paymentMethod, status, notes } = req.body;

    const nextDeparture = departureDatetime || booking.departureDatetime;
    const nextReturn = returnDatetime || booking.returnDatetime;
    if (new Date(nextReturn) <= new Date(nextDeparture)) {
      return res
        .status(400)
        .json({ message: 'La date de retour doit être postérieure à la date de départ.' });
    }

    if (departureDatetime || returnDatetime) {
      const overlapping = await VehicleBooking.findOne({
        where: {
          id: { [Op.ne]: booking.id },
          vehicleId: booking.vehicleId,
          status: { [Op.ne]: 'cancelled' },
          departureDatetime: { [Op.lt]: nextReturn },
          returnDatetime: { [Op.gt]: nextDeparture },
        },
      });
      if (overlapping) {
        return res.status(409).json({ message: 'Ce véhicule est déjà loué sur cette période.' });
      }
    }

    if (departureDatetime) booking.departureDatetime = departureDatetime;
    if (returnDatetime) booking.returnDatetime = returnDatetime;
    if (totalPrice !== undefined) booking.totalPrice = totalPrice || null;
    if (deposit !== undefined) booking.deposit = deposit || null;
    if (paymentMethod !== undefined) booking.paymentMethod = paymentMethod || null;
    if (notes !== undefined) booking.notes = notes || null;
    if (status && BOOKING_STATUSES.includes(status)) booking.status = status;

    await booking.save();

    // Montant total + acompte déclarés (CRM) : resynchronisés si le montant,
    // l'acompte ou le statut (annulation) de cette location a changé.
    if (booking.clientId) {
      const client = await Client.findByPk(booking.clientId);
      if (client) await crmService.recalculateClientFinancials(client);
    }

    const updated = await VehicleBooking.findByPk(booking.id, {
      include: [
        { model: Client, as: 'client' },
        { model: Vehicle, as: 'vehicle', attributes: ['id', 'brand', 'model', 'type'] },
        { model: Lead, as: 'lead', attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
      ],
    });

    return res.json(updated);
  } catch (err) {
    return next(err);
  }
};

exports.updateVehicleBookingStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!BOOKING_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Statut invalide.' });
    }

    const booking = await VehicleBooking.findByPk(req.params.id, {
      include: [{ model: Listing, as: 'listing' }],
    });
    if (!booking) {
      return res.status(404).json({ message: 'Location introuvable.' });
    }
    if (booking.listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    booking.status = status;
    await booking.save();

    // Montant total + acompte déclarés (CRM) : une annulation retire cette
    // location du cumul, voir crmService.
    if (booking.clientId) {
      const client = await Client.findByPk(booking.clientId);
      if (client) await crmService.recalculateClientFinancials(client);
    }

    return res.json(booking);
  } catch (err) {
    return next(err);
  }
};
