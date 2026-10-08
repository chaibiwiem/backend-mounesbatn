const { validationResult } = require('express-validator');
const db = require('../models');
const connectionFeeService = require('../services/connectionFeeService');
const crmService = require('../services/crmService');
const emailService = require('../services/emailService');
const { normalizeRooms, computeBookingTotal } = require('../utils/stay');

const { Booking, Listing, Review, Image, Category, Client, Lead, Package } = db;

const PACKAGE_ATTRIBUTES = ['id', 'name', 'price'];

// Pack d'une reservation : doit appartenir a la fiche du prestataire.
// undefined si non fourni, null si retire, false si invalide (400 envoye).
async function resolvePackage(packageId, listingId, res) {
  if (packageId === undefined) return undefined;
  if (!packageId) return null;
  const pkg = await Package.findOne({ where: { id: packageId, listingId } });
  if (!pkg) {
    res.status(400).json({ message: 'Pack invalide pour ce prestataire.' });
    return false;
  }
  return pkg;
}

const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];
const PAYMENT_METHODS = ['cash', 'rib'];
const EDITABLE_BOOKING_FIELDS = [
  'eventDate',
  'startTime',
  'endTime',
  'totalPrice',
  'deposit',
  'paymentMethod',
  'notes',
  'status',
  'checkInDate',
  'checkOutDate',
  'rooms',
  'guests',
];

async function getOwnListing(req, res) {
  const listing = await Listing.findOne({ where: { userId: req.user.id } });
  if (!listing) {
    res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    return null;
  }
  return listing;
}

// Nécessaire au client pour savoir quelle réservation il peut noter
// (US-C10) : uniquement ses propres réservations, avec l'avis déjà publié
// le cas échéant (pour ne pas proposer un second avis sur le même booking).
// image/adresse/categorie inclus pour le récapitulatif du module d'avis.
exports.getMyBookings = async (req, res, next) => {
  try {
    const bookings = await Booking.findAll({
      where: { userId: req.user.id },
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'title', 'city', 'address'],
          include: [
            { model: Category, as: 'category', attributes: ['name'] },
            {
              model: Image,
              as: 'images',
              attributes: ['url', 'isPrimary'],
              separate: true,
              order: [['isPrimary', 'DESC'], ['sortOrder', 'ASC']],
              limit: 1,
            },
          ],
        },
        { model: Review, as: 'review' },
      ],
      order: [['eventDate', 'DESC']],
    });

    return res.json(bookings);
  } catch (err) {
    return next(err);
  }
};

// Liste des réservations d'une fiche, côté prestataire (module M5) : accord
// conclus en direct, avec ou sans lead d'origine.
exports.getListingBookings = async (req, res, next) => {
  try {
    const { id } = req.params;
    const listing = await Listing.findByPk(id);
    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }
    if (listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    const bookings = await Booking.findAll({
      where: { listingId: id },
      include: [
        { model: Client, as: 'client' },
        { model: Lead, as: 'lead', attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
        { model: Review, as: 'review', attributes: ['id'] },
        { model: Package, as: 'package', attributes: PACKAGE_ATTRIBUTES },
      ],
      order: [['eventDate', 'DESC'], ['createdAt', 'DESC']],
    });

    return res.json(bookings);
  } catch (err) {
    return next(err);
  }
};

// Enregistrement manuel d'un accord conclu en direct (CLAUDE.md - aucun
// paiement en ligne, montants déclaratifs) : soit à partir d'un lead
// converti, soit création directe pour un client trouvé hors plateforme.
exports.createBooking = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const {
      leadId,
      clientId,
      clientName,
      clientEmail,
      clientPhone,
      eventDate,
      startTime,
      endTime,
      totalPrice,
      deposit,
      paymentMethod,
      status,
      notes,
      checkInDate,
      checkOutDate,
      rooms,
      guests,
      packageId,
      discountType,
      discountValue,
      servicePrice,
    } = req.body;

    const finalStatus = status || 'confirmed';
    if (!BOOKING_STATUSES.includes(finalStatus)) {
      return res.status(400).json({ message: 'Statut invalide.' });
    }
    if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ message: 'Mode de règlement invalide.' });
    }

    let lead = null;
    if (leadId) {
      lead = await Lead.findOne({ where: { id: leadId, listingId: listing.id } });
      if (!lead) {
        return res.status(404).json({ message: 'Demande introuvable.' });
      }
      const existingBooking = await Booking.findOne({ where: { leadId: lead.id } });
      if (existingBooking) {
        return res.status(409).json({
          message: 'Une réservation existe déjà pour cette demande. Modifiez-la plutôt.',
        });
      }
    }

    // Client CRM cible : existant (clientId - peut déjà être lié à un compte
    // plateforme via userId, hérité d'un lead soumis connecté), nouveau (nom
    // + coordonnées optionnelles, "client trouvé hors plateforme"), ou
    // dérivé du lead si rien n'est fourni explicitement (fiche déjà
    // auto-créée à la réception du lead - M4/M6). Le statut "client
    // plateforme" n'est jamais assigné manuellement ici : il ne provient que
    // d'une demande de devis soumise en étant connecté (lead.userId).
    let client = null;
    let platformUserId = null;
    if (clientId) {
      client = await Client.findOne({ where: { id: clientId, listingId: listing.id } });
      if (!client) {
        return res.status(404).json({ message: 'Client introuvable.' });
      }
      platformUserId = client.userId || null;
    } else if (clientName && clientName.trim()) {
      if (clientEmail) {
        [client] = await Client.findOrCreate({
          where: { listingId: listing.id, email: clientEmail },
          defaults: {
            listingId: listing.id,
            name: clientName.trim(),
            email: clientEmail,
            phone: clientPhone || null,
          },
        });
      } else {
        client = await Client.create({
          listingId: listing.id,
          name: clientName.trim(),
          phone: clientPhone || null,
        });
      }
    } else if (lead) {
      client = await crmService.findOrCreateClientForLead(lead, listing);
    } else {
      return res.status(400).json({
        message: 'Sélectionnez un client existant ou renseignez au moins son nom.',
      });
    }

    // Sejour "Maison d'hote" : valeurs du formulaire, sinon celles de la
    // demande d'origine (memes champs, voir Lead). L'arrivee sert de date
    // d'evenement (avis, calendrier) quand aucune n'est fournie.
    const stay = {
      checkInDate: checkInDate || lead?.checkInDate || null,
      checkOutDate: checkOutDate || lead?.checkOutDate || null,
      rooms: normalizeRooms(rooms) || normalizeRooms(lead?.rooms),
      guests: guests || lead?.guests || null,
    };

    // Pack : choix du formulaire, sinon celui de la demande d'origine.
    const selectedPackage = await resolvePackage(packageId, listing.id, res);
    if (selectedPackage === false) return;

    const finalPackageId = selectedPackage === undefined ? lead?.packageId || null : selectedPackage?.id || null;
    // Prix renseignes (chambres, prestation et/ou pack) : total calcule
    // (sous-total - remise), le montant envoye est ignore. Sinon montant
    // saisi tel quel - toutes categories.
    const bookingPackage = finalPackageId
      ? selectedPackage || (await Package.findByPk(finalPackageId, { attributes: PACKAGE_ATTRIBUTES }))
      : null;
    const computedTotal = computeBookingTotal({
      ...stay,
      servicePrice,
      packagePrice: bookingPackage?.price,
      discountType,
      discountValue,
    });
    const hasDiscount = Boolean(computedTotal && Number(discountValue) > 0);

    const booking = await Booking.create({
      packageId: finalPackageId,
      servicePrice: Number(servicePrice) > 0 ? servicePrice : null,
      discountType: hasDiscount ? discountType || 'amount' : null,
      discountValue: hasDiscount ? discountValue : null,
      leadId: lead ? lead.id : null,
      listingId: listing.id,
      clientId: client.id,
      userId: lead ? lead.userId : platformUserId,
      eventDate: eventDate || stay.checkInDate || null,
      ...stay,
      startTime: startTime || null,
      endTime: endTime || null,
      status: finalStatus,
      totalPrice: computedTotal ? computedTotal.total : totalPrice || null,
      deposit: deposit || null,
      paymentMethod: paymentMethod || null,
      notes: notes || null,
    });

    // Recalcule events_count + tag CRM (CLAUDE.md - Nouveau/Récurrent/VIP),
    // sauf réservation déjà annulée dès sa création.
    if (finalStatus !== 'cancelled') {
      await crmService.registerConvertedEvent(client);
    }
    // Montant total + acompte déclarés (CRM) : recalculés à partir des
    // réservations non annulées du client, voir crmService.
    await crmService.recalculateClientFinancials(client);

    // Réservation issue d'un lead : le lead passe "converti" (US-P06), même
    // logique que PATCH /api/leads/:id/status (module M4).
    if (lead && lead.status !== 'converted') {
      if (!lead.answeredAt) lead.answeredAt = new Date();
      lead.status = 'converted';
      await lead.save();
    }
    // Frais de mise en relation (M13) : demande confirmee par le prestataire
    // -> frais declares automatiquement (montant de la reservation = contrat),
    // en attente de validation admin.
    if (lead && finalStatus !== 'cancelled') {
      await connectionFeeService.autoDeclareFee(lead, listing, {
        eventDate: booking.eventDate,
        declaredAmount: booking.totalPrice,
      });
    }

    const created = await Booking.findByPk(booking.id, {
      include: [
        { model: Client, as: 'client' },
        { model: Lead, as: 'lead', attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
        { model: Package, as: 'package', attributes: PACKAGE_ATTRIBUTES },
      ],
    });

    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
};

exports.updateBooking = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const booking = await Booking.findByPk(req.params.id, {
      include: [{ model: Listing, as: 'listing' }],
    });
    if (!booking) {
      return res.status(404).json({ message: 'Réservation introuvable.' });
    }
    if (booking.listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    if (req.body.status !== undefined && !BOOKING_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ message: 'Statut invalide.' });
    }
    if (
      req.body.paymentMethod !== undefined &&
      req.body.paymentMethod !== null &&
      !PAYMENT_METHODS.includes(req.body.paymentMethod)
    ) {
      return res.status(400).json({ message: 'Mode de règlement invalide.' });
    }

    EDITABLE_BOOKING_FIELDS.forEach((field) => {
      if (req.body[field] !== undefined) booking[field] = req.body[field];
    });
    if (req.body.rooms !== undefined) booking.rooms = normalizeRooms(req.body.rooms);
    const selectedPackage = await resolvePackage(req.body.packageId, booking.listingId, res);
    if (selectedPackage === false) return;
    if (selectedPackage !== undefined) booking.packageId = selectedPackage?.id || null;
    if (req.body.discountType !== undefined) booking.discountType = req.body.discountType || null;
    if (req.body.discountValue !== undefined) booking.discountValue = req.body.discountValue || null;
    if (req.body.servicePrice !== undefined) booking.servicePrice = Number(req.body.servicePrice) > 0 ? req.body.servicePrice : null;
    // Sejour deplace : la date d'evenement (avis, calendrier) suit l'arrivee,
    // sauf si une date d'evenement explicite est aussi envoyee.
    if (req.body.checkInDate && req.body.eventDate === undefined) {
      booking.eventDate = req.body.checkInDate;
    }
    if (booking.checkInDate && booking.checkOutDate && booking.checkOutDate <= booking.checkInDate) {
      return res.status(400).json({ message: "La date de départ doit être postérieure à la date d'arrivée." });
    }

    // Prix renseignes (chambres, prestation et/ou pack) : total recalcule a
    // chaque modification (dates, chambres, prix, pack, remise). Sans aucun
    // prix : montant manuel, remise sans objet.
    const bookingPackage = booking.packageId
      ? await Package.findByPk(booking.packageId, { attributes: PACKAGE_ATTRIBUTES })
      : null;
    const computedTotal = computeBookingTotal({
      rooms: booking.rooms,
      checkInDate: booking.checkInDate,
      checkOutDate: booking.checkOutDate,
      servicePrice: booking.servicePrice,
      packagePrice: bookingPackage?.price,
      discountType: booking.discountType,
      discountValue: booking.discountValue,
    });
    if (computedTotal) {
      booking.totalPrice = computedTotal.total;
      if (!(Number(booking.discountValue) > 0)) booking.discountValue = null;
      booking.discountType = booking.discountValue ? booking.discountType || 'amount' : null;
    } else {
      booking.discountType = null;
      booking.discountValue = null;
    }

    await booking.save();
    // Frais en attente de validation : suivent le montant / la date du contrat.
    await connectionFeeService.syncPendingFeeWithBooking(booking);

    // Montant total + acompte déclarés (CRM) : resynchronisés si le montant,
    // l'acompte ou le statut (annulation) de cette réservation a changé.
    const client = await Client.findByPk(booking.clientId);
    if (client) await crmService.recalculateClientFinancials(client);

    return res.json(booking);
  } catch (err) {
    return next(err);
  }
};

// Suppression definitive d'une reservation (calendrier M5, action
// "Supprimer" du panneau de detail) - distincte du statut "cancelled" (qui
// conserve la ligne, ex: litige/historique). Recalcule le compteur
// d'evenements du client concerne, contrairement a la creation (incremental
// uniquement, jamais decremente ailleurs).
exports.deleteBooking = async (req, res, next) => {
  try {
    const booking = await Booking.findByPk(req.params.id, {
      include: [
        { model: Listing, as: 'listing' },
        { model: Client, as: 'client' },
      ],
    });
    if (!booking) {
      return res.status(404).json({ message: 'Réservation introuvable.' });
    }
    if (booking.listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    const { client } = booking;
    await booking.destroy();

    if (client) {
      await crmService.recalculateClientEventsCount(client);
      await crmService.recalculateClientFinancials(client);
    }

    return res.json({ message: 'Réservation supprimée.' });
  } catch (err) {
    return next(err);
  }
};

exports.updateBookingStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!BOOKING_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Statut invalide.' });
    }

    const booking = await Booking.findByPk(req.params.id, {
      include: [{ model: Listing, as: 'listing' }],
    });
    if (!booking) {
      return res.status(404).json({ message: 'Réservation introuvable.' });
    }
    if (booking.listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    booking.status = status;
    await booking.save();

    // Montant total + acompte déclarés (CRM) : une annulation retire cette
    // réservation du cumul, voir crmService.
    const client = await Client.findByPk(booking.clientId);
    if (client) await crmService.recalculateClientFinancials(client);

    return res.json(booking);
  } catch (err) {
    return next(err);
  }
};

// Charge la reservation du client connecte et verifie qu'elle lui appartient
// bien (userId) - factorise entre cancelMyBooking et updateMyBookingDate.
// Le prestataire gere ses reservations via updateBooking/updateBookingStatus
// (module M5, verifie par listing.userId) : ici c'est l'inverse, seul le
// client proprietaire (jamais le prestataire ni un autre client) peut agir.
async function loadOwnBookingOrRespond(req, res) {
  const booking = await Booking.findByPk(req.params.id, {
    include: [{ model: Listing, as: 'listing', include: [{ model: db.User, as: 'owner' }] }],
  });
  if (!booking) {
    res.status(404).json({ message: 'Réservation introuvable.' });
    return null;
  }
  if (booking.userId !== req.user.id) {
    res.status(403).json({ message: 'Accès interdit.' });
    return null;
  }
  return booking;
}

// Annulation par le client depuis "Mes réservations" (espace client) - action
// volontairement limitee a un changement de statut (jamais de suppression :
// l'historique reste visible cote prestataire/CRM). Impossible sur une
// reservation deja terminee ou deja annulee.
exports.cancelMyBooking = async (req, res, next) => {
  try {
    const booking = await loadOwnBookingOrRespond(req, res);
    if (!booking) return;

    if (booking.status === 'completed') {
      return res.status(409).json({ message: 'Cette réservation est déjà terminée, elle ne peut plus être annulée.' });
    }
    if (booking.status === 'cancelled') {
      return res.status(409).json({ message: 'Cette réservation est déjà annulée.' });
    }

    booking.status = 'cancelled';
    await booking.save();

    const cancelClient = await Client.findByPk(booking.clientId);
    if (cancelClient) await crmService.recalculateClientFinancials(cancelClient);

    if (booking.listing.owner) {
      await emailService.sendBookingChangedByClientEmail(booking.listing.owner, booking, booking.listing, 'cancelled');
    }

    return res.json(booking);
  } catch (err) {
    return next(err);
  }
};

// Modification de la date par le client depuis "Mes réservations" - meme
// restriction qu'une annulation : plus possible une fois la reservation
// terminee ou annulee (dans ce dernier cas le client doit recontacter le
// prestataire, pas rouvrir seul une reservation annulee).
exports.updateMyBookingDate = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const booking = await loadOwnBookingOrRespond(req, res);
    if (!booking) return;

    if (booking.status === 'completed' || booking.status === 'cancelled') {
      return res.status(409).json({
        message: 'Cette réservation ne peut plus être modifiée. Contactez directement le prestataire.',
      });
    }

    booking.eventDate = req.body.eventDate;
    await booking.save();

    if (booking.listing.owner) {
      await emailService.sendBookingChangedByClientEmail(booking.listing.owner, booking, booking.listing, 'date');
    }

    return res.json(booking);
  } catch (err) {
    return next(err);
  }
};
