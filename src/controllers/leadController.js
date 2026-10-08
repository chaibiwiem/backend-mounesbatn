const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const ExcelJS = require('exceljs');
const db = require('../models');
const emailService = require('../services/emailService');
const crmService = require('../services/crmService');
const { isTransportListing } = require('../services/transportService');
const { isProductCategoryListing } = require('../services/productCategoryService');
const { isAccommodationListing } = require('../services/accommodationService');
const { stayNights } = require('../utils/stay');
const connectionFeeService = require('../services/connectionFeeService');

const STATUS_EXPORT_LABELS = {
  new: 'En attente',
  late: 'En attente',
  answered: 'Traitées',
  converted: 'Confirmées',
  lost: 'Refusées',
};

const {
  Lead,
  Listing,
  User,
  Booking,
  Client,
  Vehicle,
  VehicleDecoration,
  VehicleBooking,
  VehicleOption,
  LeadOption,
  ProviderEvent,
  Package,
  Availability,
  Commission,
} = db;


// Attributs renvoyes pour chaque option choisie (LeadOption + son
// VehicleOption) - reutilise sur getListingLeads/exportListingLeads.
const SELECTED_OPTIONS_INCLUDE = {
  model: LeadOption,
  as: 'selectedOptions',
  include: [{ model: VehicleOption, as: 'option', attributes: ['id', 'name', 'price', 'pricingType'] }],
};

const DUPLICATE_WINDOW_MINUTES = 10;
const ALLOWED_MANUAL_STATUSES = ['answered', 'converted', 'lost'];

// Meme regle de facturation que le front (VehicleBookingModal/BookingFormModal/
// LeadsTab, voir frontend/src/utils/rentalPricing.js) : location de moins de
// 24h facturee au tarif horaire si defini, sinon au tarif/jour (toute journee
// entamee compte, jamais 0), plus le prix du modele de decoration choisi et
// des options supplementaires (par jour x duree, ou forfait unique).
const estimatedLeadAmount = (lead) => {
  if (!lead.departureDatetime || !lead.returnDatetime) return null;
  const diff = new Date(lead.returnDatetime).getTime() - new Date(lead.departureDatetime).getTime();
  if (diff <= 0) return null;
  const hours = Math.ceil(diff / (60 * 60 * 1000));
  const days = Math.ceil(hours / 24);

  // Les champs DECIMAL Sequelize sont retournes en chaines ("0.00"), donc
  // truthy meme a zero - il faut comparer la valeur numerique.
  const decorationPrice = Number(lead.decoration?.price);
  const decorationAmount = decorationPrice > 0 ? decorationPrice : 0;

  const optionsAmount = (lead.selectedOptions || []).reduce((sum, selected) => {
    const price = Number(selected.option?.price);
    if (!(price > 0)) return sum;
    const quantity = selected.quantity || 1;
    const unitAmount = selected.option.pricingType === 'flat' ? price : price * days;
    return sum + unitAmount * quantity;
  }, 0);

  const extrasAmount = decorationAmount + optionsAmount;

  if (!lead.vehicle) return extrasAmount > 0 ? Math.round(extrasAmount * 100) / 100 : null;

  const pricePerHour = Number(lead.vehicle.pricePerHour);
  const pricePerDay = Number(lead.vehicle.pricePerDay);

  if (hours < 24 && pricePerHour > 0) {
    return Math.round((hours * pricePerHour + extrasAmount) * 100) / 100;
  }
  if (pricePerDay > 0) {
    return Math.round((days * pricePerDay + extrasAmount) * 100) / 100;
  }
  return extrasAmount > 0 ? Math.round(extrasAmount * 100) / 100 : null;
};

exports.createLead = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  // Un prestataire ne peut pas envoyer de demande de devis (cahier des
  // charges, section 2.1 - règles métier).
  if (req.user && req.user.role === 'provider') {
    return res
      .status(403)
      .json({ message: 'Un prestataire ne peut pas envoyer de demande de devis.' });
  }

  const {
    listingId,
    firstName,
    lastName,
    email,
    phone,
    eventDate,
    dateFlexible,
    guests,
    message,
    departureDatetime,
    returnDatetime,
    passengers,
    vehicleId,
    withDriver,
    decorationId,
    pickupLocation,
    options,
    providerEventId,
    packageId,
    quantity,
    deliveryDate,
    deliveryMode,
    deliveryAddress,
    customization,
    checkInDate,
    checkOutDate,
    rooms,
  } = req.body;

  try {
    const listing = await Listing.findOne({ where: { id: listingId, status: 'active' } });
    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }

    // Anti-spam par email : bloque les envois repetes vers la meme fiche en
    // moins de 10 minutes (en complement du rate limiting par IP).
    const recentDuplicate = await Lead.findOne({
      where: {
        listingId,
        email,
        createdAt: {
          [Op.gte]: new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60 * 1000),
        },
      },
    });
    if (recentDuplicate) {
      return res.status(429).json({
        message: 'Une demande a déjà été envoyée récemment pour ce prestataire. Merci de patienter.',
      });
    }

    // Demande d'interet sur un evenement prestataire ("Je suis interesse(e)",
    // M5) : independant de la categorie Transport, verifie ici que
    // l'evenement appartient bien a ce prestataire et est publie (evite
    // qu'un appelant rattache une demande a l'evenement d'un autre listing
    // ou a un brouillon non visible publiquement).
    let validatedProviderEvent = null;
    if (providerEventId) {
      validatedProviderEvent = await ProviderEvent.findOne({
        where: { id: providerEventId, listingId: listing.id, isPublished: true },
      });
      if (!validatedProviderEvent) {
        return res.status(400).json({ message: 'Événement invalide pour ce prestataire.' });
      }
    }

    // Champs de location de vehicule : uniquement conserves pour un
    // prestataire de categorie Transport, jamais pour les autres (ignores
    // silencieusement si un appelant les envoie hors contexte). Explicitement
    // a null par defaut plutot qu'omis : Sequelize ne re-interroge pas la
    // ligne apres create(), un champ omis resterait `undefined` sur l'instance
    // renvoyee au lieu de refleter le NULL reellement stocke en base.
    let transportFields = {
      departureDatetime: null,
      returnDatetime: null,
      passengers: null,
      vehicleId: null,
      withDriver: null,
      decorationId: null,
      pickupLocation: null,
    };
    let selectedDecoration = null;
    let validatedOptions = [];
    if (await isTransportListing(listing)) {
      if (vehicleId) {
        const vehicle = await Vehicle.findOne({
          where: { id: vehicleId, listingId: listing.id, isAvailable: true },
        });
        if (!vehicle) {
          return res.status(400).json({ message: 'Véhicule invalide pour ce prestataire.' });
        }

        // Bloque toute demande dont la periode chevauche une location deja
        // active pour ce vehicule (meme regle anti-chevauchement que
        // vehicleBookingController.createVehicleBooking, cote prestataire).
        if (departureDatetime && returnDatetime) {
          const overlapping = await VehicleBooking.findOne({
            where: {
              vehicleId,
              status: { [Op.ne]: 'cancelled' },
              departureDatetime: { [Op.lt]: returnDatetime },
              returnDatetime: { [Op.gt]: departureDatetime },
            },
          });
          if (overlapping) {
            return res.status(409).json({
              message: 'Ce véhicule est déjà réservé sur cette période. Merci de choisir d’autres dates.',
            });
          }
        }
      }
      if (decorationId) {
        selectedDecoration = await VehicleDecoration.findOne({
          where: { id: decorationId, vehicleId: vehicleId || undefined, isAvailable: true },
        });
        if (!selectedDecoration) {
          return res.status(400).json({ message: 'Modèle de décoration invalide pour ce véhicule.' });
        }
      }
      if (Array.isArray(options) && options.length > 0 && vehicleId) {
        for (const item of options) {
          const quantity = Number(item?.quantity) || 1;
          const option = await VehicleOption.findOne({
            where: { id: item?.vehicleOptionId, vehicleId, isAvailable: true },
          });
          if (!option) {
            return res.status(400).json({ message: 'Option invalide pour ce véhicule.' });
          }
          if (quantity < 1 || quantity > option.maxQuantity) {
            return res.status(400).json({ message: `Quantité invalide pour l'option « ${option.name} ».` });
          }
          validatedOptions.push({ option, quantity });
        }
      }
      transportFields = {
        departureDatetime: departureDatetime || null,
        returnDatetime: returnDatetime || null,
        passengers: passengers || null,
        vehicleId: vehicleId || null,
        withDriver: withDriver === undefined ? null : Boolean(withDriver),
        decorationId: decorationId || null,
        pickupLocation: pickupLocation || null,
      };
    }

    // Champs produit (quantite/livraison/personnalisation) : uniquement
    // conserves pour un prestataire de categorie "Parfums & Soins", jamais
    // pour les autres (ignores silencieusement si un appelant les envoie
    // hors contexte) - meme traitement que transportFields ci-dessus.
    let productFields = {
      quantity: null,
      deliveryDate: null,
      deliveryMode: null,
      deliveryAddress: null,
      packageId: null,
      customization: null,
    };
    // Pack / produit choisi : conserve pour toutes les categories (pack coche
    // sur la fiche), mais doit appartenir a la fiche demandee.
    const isProductListing = await isProductCategoryListing(listing);
    let selectedPackage = null;
    if (packageId) {
      selectedPackage = await Package.findOne({ where: { id: packageId, listingId: listing.id } });
      if (!selectedPackage) {
        return res.status(400).json({
          message: isProductListing ? 'Produit invalide pour ce prestataire.' : 'Pack invalide pour ce prestataire.',
        });
      }
      productFields.packageId = selectedPackage.id;
    }
    if (isProductListing) {
      productFields = {
        quantity: quantity || null,
        deliveryDate: deliveryDate || null,
        deliveryMode: deliveryMode || null,
        deliveryAddress: deliveryMode === 'livraison' ? deliveryAddress || null : null,
        packageId: selectedPackage ? selectedPackage.id : null,
        customization: customization || null,
      };
    }

    // Champs sejour (Arrivee/Depart + chambres) : uniquement conserves pour un
    // prestataire "Maison d'hote", jamais pour les autres (ignores
    // silencieusement si un appelant les envoie hors contexte) - meme
    // traitement que transportFields/productFields ci-dessus.
    let accommodationFields = { checkInDate: null, checkOutDate: null, rooms: null };
    if (await isAccommodationListing(listing)) {
      if (checkInDate && checkOutDate) {
        const nights = stayNights(checkInDate, checkOutDate);
        const blockedAvailability = await Availability.findOne({
          where: { listingId: listing.id, date: { [Op.in]: nights }, isAvailable: false },
        });
        // Reservation confirmee qui chevauche : un sejour reserve bloque toutes
        // ses nuits [arrivee, depart[, une reservation sans sejour bloque sa
        // seule date d'evenement.
        const blockedBooking = await Booking.findOne({
          where: {
            listingId: listing.id,
            status: { [Op.in]: ['confirmed', 'completed'] },
            [Op.or]: [
              {
                checkInDate: { [Op.ne]: null, [Op.lt]: checkOutDate },
                checkOutDate: { [Op.gt]: checkInDate },
              },
              { checkInDate: null, eventDate: { [Op.in]: nights } },
            ],
          },
        });
        if (blockedAvailability || blockedBooking) {
          return res.status(409).json({
            message: 'Ces dates ne sont plus disponibles pour ce prestataire. Merci de choisir d’autres dates.',
          });
        }
      }
      accommodationFields = {
        checkInDate: checkInDate || null,
        checkOutDate: checkOutDate || null,
        rooms: Array.isArray(rooms) && rooms.length > 0 ? rooms : null,
      };
    }

    const lead = await Lead.create({
      listingId,
      userId: req.user ? req.user.id : null,
      firstName,
      lastName,
      email,
      phone,
      eventDate: eventDate || null,
      dateFlexible: Boolean(dateFlexible),
      guests,
      message,
      status: 'new',
      providerEventId: validatedProviderEvent ? validatedProviderEvent.id : null,
      ...transportFields,
      ...productFields,
      ...accommodationFields,
    });
    // Association deja resolue plus haut (pas besoin de re-interroger) :
    // Sequelize ne recharge pas les includes apres create(), donc affectee
    // manuellement pour que emailService puisse lire lead.decoration.name /
    // lead.interestedEvent.title / lead.package.name.
    lead.decoration = selectedDecoration;
    lead.interestedEvent = validatedProviderEvent;
    lead.package = selectedPackage;

    if (validatedOptions.length > 0) {
      await LeadOption.bulkCreate(
        validatedOptions.map(({ option, quantity }) => ({
          leadId: lead.id,
          vehicleOptionId: option.id,
          quantity,
        }))
      );
    }
    // Meme logique que lead.decoration ci-dessus : affectee manuellement
    // (memes objets deja charges) pour que emailService/estimatedLeadAmount
    // puissent lire lead.selectedOptions sans re-interroger la base.
    lead.selectedOptions = validatedOptions.map(({ option, quantity }) => ({
      vehicleOptionId: option.id,
      quantity,
      option,
    }));

    // Fiche client auto-créée à chaque demande (US-P07 / module M6).
    await crmService.findOrCreateClientForLead(lead, listing);

    const providerUser = await User.findByPk(listing.userId);
    if (providerUser) {
      await emailService.sendNewLeadEmail(providerUser, lead, listing);
    }
    await emailService.sendLeadAcknowledgementEmail(lead, listing);

    // lead.decoration / lead.selectedOptions / lead.package ont ete affectes
    // manuellement plus haut (pas de re-requete) : ce sont de simples
    // proprietes JS, pas des dataValues Sequelize - toJSON() (utilise par
    // res.json ci-dessous) ne les inclurait pas automatiquement, d'ou la
    // fusion explicite.
    return res.status(201).json({
      message: 'Votre demande a bien été envoyée.',
      lead: {
        ...lead.toJSON(),
        decoration: lead.decoration,
        selectedOptions: lead.selectedOptions,
        package: lead.package,
      },
    });
  } catch (err) {
    return next(err);
  }
};

exports.getMyLeads = async (req, res, next) => {
  try {
    const leads = await Lead.findAll({
      where: { userId: req.user.id },
      include: [{ model: Listing, as: 'listing', attributes: ['id', 'title', 'city'] }],
      order: [['createdAt', 'DESC']],
    });

    return res.json(leads);
  } catch (err) {
    return next(err);
  }
};

exports.getListingLeads = async (req, res, next) => {
  try {
    const { id } = req.params;
    const listing = await Listing.findByPk(id);

    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }

    if (listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    // Les demandes d'interet sur un evenement prestataire (M5, "Je suis
    // interesse(e)") ont leur propre liste dans l'onglet "Mes evenements"
    // (getListingEventLeads) - exclues ici pour ne pas polluer "Demandes de
    // devis" avec des contacts qui ne portent pas sur une prestation datee.
    const leads = await Lead.findAll({
      where: { listingId: id, providerEventId: null },
      include: [
        { model: Vehicle, as: 'vehicle', attributes: ['id', 'brand', 'model', 'type', 'pricePerDay', 'pricePerHour'] },
        { model: VehicleDecoration, as: 'decoration', attributes: ['id', 'name', 'price'] },
        { model: Package, as: 'package', attributes: ['id', 'name', 'price'] },
        // Frais de mise en relation (M13) : statut de la confirmation.
        {
          model: Commission,
          as: 'commission',
          attributes: ['id', 'status', 'amount', 'eventDate', 'cancelReason'],
        },
        // Reservation issue de la demande : son montant TOTAL sert de base aux
        // frais en pourcentage (pre-rempli dans le formulaire de confirmation).
        { model: Booking, as: 'bookings', attributes: ['id', 'totalPrice', 'deposit', 'eventDate'] },
        SELECTED_OPTIONS_INCLUDE,
      ],
      order: [['createdAt', 'DESC']],
    });

    const total = leads.length;
    const answeredWithin24h = leads.filter((lead) => {
      if (!lead.answeredAt) return false;
      return lead.answeredAt.getTime() - lead.createdAt.getTime() <= 24 * 60 * 60 * 1000;
    }).length;

    const responseRate = total > 0 ? Math.round((answeredWithin24h / total) * 100) : null;

    // Taux de conversion (M13 - incitation a confirmer) : dans une categorie
    // concernee par les frais de mise en relation, seules les demandes
    // confirmees ET validees par Mounesba comptent comme converties ; ailleurs,
    // les demandes passees au statut "converti".
    const feeCategory = await connectionFeeService.resolveFeeCategory(listing);
    const realizedCount = leads.filter((lead) =>
      connectionFeeService.REALIZED_STATUSES.includes(lead.commission?.status)
    ).length;
    const convertedCount = feeCategory ? realizedCount : leads.filter((lead) => lead.status === 'converted').length;
    const conversionRate = total > 0 ? Math.round((convertedCount / total) * 100) : null;

    return res.json({
      leads,
      stats: {
        total,
        responseRate,
        fastResponseBadge: responseRate === null ? true : responseRate >= 50,
        convertedCount,
        conversionRate,
        realizedCount,
      },
      connectionFee: feeCategory
        ? {
            concerned: true,
            ...connectionFeeService.describeRate(feeCategory),
            termsAccepted: connectionFeeService.hasAcceptedTerms(listing),
            termsVersion: connectionFeeService.TERMS_VERSION,
          }
        : { concerned: false },
    });
  } catch (err) {
    return next(err);
  }
};

// Demandes d'interet issues du bouton "Je suis interesse(e)" sur un
// evenement prestataire (M5, "Mes evenements") - liste dediee, distincte de
// "Demandes de devis" (getListingLeads exclut ces leads, voir plus haut).
exports.getListingEventLeads = async (req, res, next) => {
  try {
    const { id } = req.params;
    const listing = await Listing.findByPk(id);

    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }

    if (listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    const leads = await Lead.findAll({
      where: { listingId: id, providerEventId: { [Op.ne]: null } },
      include: [{ model: ProviderEvent, as: 'interestedEvent', attributes: ['id', 'title', 'eventDate'] }],
      order: [['createdAt', 'DESC']],
    });

    return res.json({ leads, stats: { total: leads.length } });
  } catch (err) {
    return next(err);
  }
};

exports.exportListingLeads = async (req, res, next) => {
  try {
    const { id } = req.params;
    const listing = await Listing.findByPk(id);

    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }

    if (listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    // Meme exclusion que getListingLeads : les demandes d'interet evenement
    // ont leur propre export (a venir si besoin), pas melangees ici.
    const leads = await Lead.findAll({
      where: { listingId: id, providerEventId: null },
      include: [
        { model: Vehicle, as: 'vehicle', attributes: ['id', 'brand', 'model', 'type', 'pricePerDay', 'pricePerHour'] },
        { model: VehicleDecoration, as: 'decoration', attributes: ['id', 'name', 'price'] },
        { model: Package, as: 'package', attributes: ['id', 'name', 'price'] },
        SELECTED_OPTIONS_INCLUDE,
      ],
      order: [['createdAt', 'DESC']],
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Demandes de devis');

    sheet.columns = [
      { header: 'Prénom', key: 'firstName', width: 18 },
      { header: 'Nom', key: 'lastName', width: 18 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Téléphone', key: 'phone', width: 16 },
      { header: "Date de l'événement", key: 'eventDate', width: 20 },
      { header: 'Date flexible', key: 'dateFlexible', width: 14 },
      { header: 'Invités', key: 'guests', width: 14 },
      { header: 'Départ (location)', key: 'departureDatetime', width: 20 },
      { header: 'Retour (location)', key: 'returnDatetime', width: 20 },
      { header: 'Passagers', key: 'passengers', width: 12 },
      { header: 'Véhicule', key: 'vehicle', width: 20 },
      { header: 'Chauffeur', key: 'withDriver', width: 16 },
      { header: 'Décoration', key: 'decoration', width: 20 },
      { header: 'Options', key: 'options', width: 30 },
      { header: 'Lieu de prise en charge', key: 'pickupLocation', width: 26 },
      { header: 'Montant estimé (DT)', key: 'estimatedAmount', width: 18 },
      { header: 'Pack / produit souhaité', key: 'package', width: 24 },
      { header: 'Quantité', key: 'quantity', width: 12 },
      { header: 'Date de livraison souhaitée', key: 'deliveryDate', width: 22 },
      { header: 'Mode de livraison', key: 'deliveryMode', width: 16 },
      { header: 'Adresse de livraison', key: 'deliveryAddress', width: 26 },
      { header: 'Personnalisation', key: 'customization', width: 30 },
      { header: 'Arrivée (séjour)', key: 'checkInDate', width: 16 },
      { header: 'Départ (séjour)', key: 'checkOutDate', width: 16 },
      { header: 'Chambres et occupation', key: 'rooms', width: 40 },
      { header: 'Statut', key: 'status', width: 14 },
      { header: 'Message', key: 'message', width: 40 },
      { header: 'Reçue le', key: 'createdAt', width: 20 },
    ];
    sheet.getRow(1).font = { bold: true };

    leads.forEach((lead) => {
      sheet.addRow({
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email,
        phone: lead.phone,
        eventDate: lead.eventDate || '',
        dateFlexible: lead.dateFlexible ? 'Oui' : 'Non',
        guests: lead.guests || '',
        departureDatetime: lead.departureDatetime
          ? lead.departureDatetime.toISOString().slice(0, 16).replace('T', ' ')
          : '',
        returnDatetime: lead.returnDatetime
          ? lead.returnDatetime.toISOString().slice(0, 16).replace('T', ' ')
          : '',
        passengers: lead.passengers || '',
        vehicle: lead.vehicle
          ? [lead.vehicle.brand, lead.vehicle.model].filter(Boolean).join(' ')
          : '',
        withDriver: lead.withDriver === null ? '' : lead.withDriver ? 'Avec chauffeur' : 'Sans chauffeur',
        decoration: lead.decoration?.name || '',
        options: (lead.selectedOptions || [])
          .map((selected) => `${selected.option?.name} x${selected.quantity}`)
          .join(', '),
        pickupLocation: lead.pickupLocation || '',
        estimatedAmount: estimatedLeadAmount(lead) ?? '',
        package: lead.package?.name || '',
        quantity: lead.quantity || '',
        deliveryDate: lead.deliveryDate || '',
        deliveryMode: lead.deliveryMode === 'livraison' ? 'Livraison' : lead.deliveryMode === 'retrait' ? 'Retrait' : '',
        deliveryAddress: lead.deliveryAddress || '',
        customization: lead.customization || '',
        checkInDate: lead.checkInDate || '',
        checkOutDate: lead.checkOutDate || '',
        rooms: Array.isArray(lead.rooms)
          ? lead.rooms
              .map(
                (room, index) =>
                  `Ch. ${index + 1} : ${room.adults} ad., ${room.children || 0} enf., ${room.babies || 0} bébé`
              )
              .join(' | ')
          : '',
        status: STATUS_EXPORT_LABELS[lead.status] || lead.status,
        message: lead.message || '',
        createdAt: lead.createdAt.toISOString().slice(0, 16).replace('T', ' '),
      });
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="demandes-devis-${id}.xlsx"`
    );

    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    return next(err);
  }
};

exports.updateLeadStatus = async (req, res, next) => {
  const { status } = req.body;

  if (!ALLOWED_MANUAL_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Statut invalide.' });
  }

  try {
    const { id } = req.params;
    const lead = await Lead.findByPk(id, { include: [{ model: Listing, as: 'listing' }] });

    if (!lead) {
      return res.status(404).json({ message: 'Demande introuvable.' });
    }

    if (lead.listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    if (!lead.answeredAt && ['answered', 'converted', 'lost'].includes(status)) {
      lead.answeredAt = new Date();
    }
    lead.status = status;
    await lead.save();

    // Un lead converti devient la trace d'un événement confirmé hors-ligne
    // (schéma : bookings.lead_id, "trace d'un lead converti") et incrémente
    // le compteur d'événements de la fiche CRM du client (module M6).
    if (status === 'converted') {
      const existingBooking = await Booking.findOne({ where: { leadId: lead.id } });
      if (!existingBooking) {
        const client = await Client.findOne({
          where: { listingId: lead.listingId, email: lead.email },
        });
        if (client) {
          await crmService.registerConvertedEvent(client);
        }

        await Booking.create({
          leadId: lead.id,
          listingId: lead.listingId,
          clientId: client ? client.id : null,
          userId: lead.userId,
          // Sejour "Maison d'hote" : l'arrivee sert de date d'evenement, et le
          // detail du sejour suit la demande (meme logique que createBooking).
          eventDate: lead.eventDate || lead.checkInDate || null,
          checkInDate: lead.checkInDate || null,
          checkOutDate: lead.checkOutDate || null,
          rooms: lead.rooms || null,
          guests: lead.guests || null,
          packageId: lead.packageId || null,
          status: 'confirmed',
        });
      }
      // Frais de mise en relation (M13) : declares automatiquement au forfait
      // fixe ; en pourcentage, faute de montant, le prestataire confirme via
      // le formulaire (montant du contrat obligatoire).
      const booking = await Booking.findOne({ where: { leadId: lead.id } });
      await connectionFeeService.autoDeclareFee(lead, await Listing.findByPk(lead.listingId), {
        eventDate: booking?.eventDate,
        declaredAmount: booking?.totalPrice,
      });
    }

    return res.json({ message: 'Statut mis à jour.', lead });
  } catch (err) {
    return next(err);
  }
};
