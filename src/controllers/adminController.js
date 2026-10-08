const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Op, fn, col } = require('sequelize');
const { validationResult } = require('express-validator');
const db = require('../models');
const connectionFeeService = require('../services/connectionFeeService');
const emailService = require('../services/emailService');
const reviewService = require('../services/reviewService');
const providerPurgeService = require('../services/providerPurgeService');
const { storeVerifiedImage, storeLegalImage, detectRealMimeType, LEGAL_FOLDER } = require('../middleware/upload');
const { readPrivateFile, deletePrivateFile } = require('../services/storageService');
const { PLAN_CATALOG, VALID_PLANS, addInterval, updatePlanCatalogEntry } = require('../services/planService');
const { generateUniqueListingSlug } = require('../utils/slugify');

const {
  User,
  Listing,
  Category,
  Lead,
  Booking,
  Subscription,
  Dispute,
  Review,
  ReviewPhoto,
  Image,
  Plan,
  Video,
  Package,
  Promotion,
  Availability,
  Favorite,
  Contract,
  Invoice,
  Client,
} = db;

const LEAD_STATUSES = ['new', 'answered', 'late', 'converted', 'lost'];
const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];

// Construit un where `createdAt` optionnel a partir de ?from=YYYY-MM-DD et/ou
// ?to=YYYY-MM-DD (bornes inclusives) - utilise par les deux endpoints de
// statistiques prestataire (US-A02, MODULES.md M10).
function buildPeriodFilter(from, to) {
  if (!from && !to) return {};
  const range = {};
  if (from) range[Op.gte] = new Date(`${from}T00:00:00`);
  if (to) range[Op.lte] = new Date(`${to}T23:59:59`);
  return { createdAt: range };
}

const VALID_DISPUTE_STATUSES = ['open', 'in_review', 'resolved', 'rejected'];
const VALID_LISTING_STATUSES = ['pending', 'active', 'suspended', 'rejected'];
const BCRYPT_COST = 12;
const TEMP_PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

// Genere un mot de passe temporaire lisible (facile a transmettre oralement
// ou par SMS/WhatsApp a un prestataire peu digitalise), sans caracteres
// ambigus (0/O, 1/l/I).
function generateTemporaryPassword() {
  const bytes = crypto.randomBytes(10);
  let password = '';
  for (let i = 0; i < bytes.length; i += 1) {
    password += TEMP_PASSWORD_CHARS[bytes[i] % TEMP_PASSWORD_CHARS.length];
  }
  return password;
}

// --- Validation des prestataires (US-A01) ---------------------------------

exports.getPendingProviders = async (req, res, next) => {
  try {
    const listings = await Listing.findAll({
      where: { status: 'pending' },
      include: [
        {
          model: User,
          as: 'owner',
          attributes: ['id', 'firstName', 'lastName', 'email', 'phone', 'createdAt'],
        },
        { model: Category, as: 'category', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'ASC']],
    });

    return res.json(listings);
  } catch (err) {
    return next(err);
  }
};

// Table complete des prestataires (tous statuts), avec recherche et filtre,
// pour la gestion courante (distincte de la file de validation "pending").
exports.getAllProviders = async (req, res, next) => {
  try {
    const { q, status, plan, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const where = {};
    if (status && VALID_LISTING_STATUSES.includes(status)) {
      where.status = status;
    }

    const andConditions = [];

    if (q) {
      const matchingOwners = await User.findAll({
        where: {
          role: 'provider',
          [Op.or]: [
            { firstName: { [Op.like]: `%${q}%` } },
            { lastName: { [Op.like]: `%${q}%` } },
            { email: { [Op.like]: `%${q}%` } },
          ],
        },
        attributes: ['id'],
      });
      const ownerIds = matchingOwners.map((owner) => owner.id);

      andConditions.push({
        [Op.or]: [
          { title: { [Op.like]: `%${q}%` } },
          { userId: { [Op.in]: ownerIds.length ? ownerIds : [-1] } },
        ],
      });
    }

    if (plan && VALID_PLANS.includes(plan)) {
      const matchingSubscriptions = await Subscription.findAll({
        where: { plan },
        attributes: ['userId'],
      });
      const planUserIds = matchingSubscriptions.map((s) => s.userId);
      andConditions.push({ userId: { [Op.in]: planUserIds.length ? planUserIds : [-1] } });
    }

    if (andConditions.length > 0) {
      where[Op.and] = andConditions;
    }

    const { rows, count } = await Listing.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: 'owner',
          attributes: ['id', 'firstName', 'lastName', 'email', 'phone'],
          include: [
            {
              model: Subscription,
              as: 'subscriptions',
              attributes: [
                'id',
                'plan',
                'billingCycle',
                'status',
                'price',
                'startDate',
                'endDate',
                'paymentReference',
                'notes',
              ],
            },
          ],
        },
        { model: Category, as: 'category', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
      limit: limitNum,
      offset: (pageNum - 1) * limitNum,
      distinct: true,
    });

    return res.json({
      listings: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil(count / limitNum),
      },
    });
  } catch (err) {
    return next(err);
  }
};

// --- Statistiques de reservations par prestataire (M10) -------------------
// Nuance importante : les leads sont generes automatiquement par la
// plateforme (donnee fiable) ; les bookings sont saisis manuellement par le
// prestataire (donnee declarative, potentiellement incomplete - CLAUDE.md/
// MODULES.md M5). Les deux compteurs sont donc toujours renvoyes separement,
// jamais fusionnes en un seul total, pour que l'admin garde cette distinction
// a l'esprit.

// Fiche individuelle : repartition par statut + taux + dernieres dates,
// pour un prestataire donne. Filtre optionnel par periode (?from&to).
exports.getProviderStats = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id, { attributes: ['id', 'title'] });
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }

    const { from, to } = req.query;
    const periodFilter = buildPeriodFilter(from, to);
    const leadWhere = { listingId: listing.id, ...periodFilter };
    const bookingWhere = { listingId: listing.id, ...periodFilter };

    const [leadStatusRows, bookingStatusRows, respondedCount, platformBookingsCount, lastLead, lastBooking] =
      await Promise.all([
        Lead.findAll({
          where: leadWhere,
          attributes: ['status', [fn('COUNT', col('id')), 'count']],
          group: ['status'],
          raw: true,
        }),
        Booking.findAll({
          where: bookingWhere,
          attributes: ['status', [fn('COUNT', col('id')), 'count']],
          group: ['status'],
          raw: true,
        }),
        Lead.count({ where: { ...leadWhere, answeredAt: { [Op.not]: null } } }),
        // Origine du booking (CLAUDE.md/MODULES.md M5) : leadId renseigne =
        // issu d'un lead converti (plateforme) ; NULL = saisi directement par
        // le prestataire pour un client trouve hors plateforme.
        Booking.count({ where: { ...bookingWhere, leadId: { [Op.not]: null } } }),
        Lead.findOne({ where: leadWhere, order: [['createdAt', 'DESC']], attributes: ['createdAt'] }),
        Booking.findOne({ where: bookingWhere, order: [['createdAt', 'DESC']], attributes: ['createdAt'] }),
      ]);

    const leadsByStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]));
    leadStatusRows.forEach((row) => {
      leadsByStatus[row.status] = Number(row.count);
    });
    const leadsTotal = Object.values(leadsByStatus).reduce((sum, n) => sum + n, 0);

    const bookingsByStatus = Object.fromEntries(BOOKING_STATUSES.map((s) => [s, 0]));
    bookingStatusRows.forEach((row) => {
      bookingsByStatus[row.status] = Number(row.count);
    });
    const bookingsTotal = Object.values(bookingsByStatus).reduce((sum, n) => sum + n, 0);

    return res.json({
      listingId: listing.id,
      title: listing.title,
      leadsTotal,
      leadsByStatus,
      bookingsTotal,
      bookingsByStatus,
      bookingsByOrigin: {
        platform: platformBookingsCount,
        offPlatform: bookingsTotal - platformBookingsCount,
      },
      conversionRate: leadsTotal > 0 ? leadsByStatus.converted / leadsTotal : 0,
      responseRate: leadsTotal > 0 ? respondedCount / leadsTotal : 0,
      lastLeadAt: lastLead?.createdAt || null,
      lastBookingAt: lastBooking?.createdAt || null,
      period: { from: from || null, to: to || null },
    });
  } catch (err) {
    return next(err);
  }
};

// Liste paginee de tous les prestataires avec leurs compteurs - tri par
// nombre de leads ou de reservations, filtres categorie/ville/periode. Le tri
// porte sur un total agrege (pas une colonne SQL directe) : comme pour le tri
// par defaut de la recherche publique (listingController.searchListings), on
// trie/pagine cote JS plutot que d'injecter un ORDER BY sur une sous-requete
// agregee - le volume de fiches reste modeste pour cette plateforme.
exports.getProvidersStats = async (req, res, next) => {
  try {
    const { category, city, from, to, sort = 'leads', page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const listingWhere = {};
    if (category) listingWhere.categoryId = category;
    if (city) listingWhere.city = city;

    const listings = await Listing.findAll({
      where: listingWhere,
      attributes: ['id', 'title', 'city', 'status'],
      include: [{ model: Category, as: 'category', attributes: ['id', 'name', 'slug'] }],
      order: [['title', 'ASC']],
    });

    if (listings.length === 0) {
      return res.json({
        results: [],
        pagination: { page: pageNum, limit: limitNum, total: 0, totalPages: 1 },
      });
    }

    const listingIds = listings.map((l) => l.id);
    const periodFilter = buildPeriodFilter(from, to);

    const [leadCounts, bookingCounts, convertedCounts, platformBookingCounts] = await Promise.all([
      Lead.findAll({
        where: { listingId: listingIds, ...periodFilter },
        attributes: ['listingId', [fn('COUNT', col('id')), 'count']],
        group: ['listingId'],
        raw: true,
      }),
      Booking.findAll({
        where: { listingId: listingIds, ...periodFilter },
        attributes: ['listingId', [fn('COUNT', col('id')), 'count']],
        group: ['listingId'],
        raw: true,
      }),
      Lead.findAll({
        where: { listingId: listingIds, status: 'converted', ...periodFilter },
        attributes: ['listingId', [fn('COUNT', col('id')), 'count']],
        group: ['listingId'],
        raw: true,
      }),
      // Origine des bookings (CLAUDE.md/MODULES.md M5) : leadId renseigne =
      // issu d'un lead converti (plateforme) ; NULL = saisi directement par
      // le prestataire (client trouve hors plateforme).
      Booking.findAll({
        where: { listingId: listingIds, leadId: { [Op.not]: null }, ...periodFilter },
        attributes: ['listingId', [fn('COUNT', col('id')), 'count']],
        group: ['listingId'],
        raw: true,
      }),
    ]);

    const toCountMap = (rows) => new Map(rows.map((r) => [Number(r.listingId), Number(r.count)]));
    const leadMap = toCountMap(leadCounts);
    const bookingMap = toCountMap(bookingCounts);
    const convertedMap = toCountMap(convertedCounts);
    const platformBookingMap = toCountMap(platformBookingCounts);

    const results = listings.map((listing) => {
      const leadsTotal = leadMap.get(listing.id) || 0;
      const bookingsTotal = bookingMap.get(listing.id) || 0;
      const converted = convertedMap.get(listing.id) || 0;
      const bookingsPlatform = platformBookingMap.get(listing.id) || 0;
      return {
        listingId: listing.id,
        title: listing.title,
        city: listing.city,
        status: listing.status,
        category: listing.category,
        leadsTotal,
        bookingsTotal,
        bookingsByOrigin: { platform: bookingsPlatform, offPlatform: bookingsTotal - bookingsPlatform },
        conversionRate: leadsTotal > 0 ? converted / leadsTotal : 0,
      };
    });

    results.sort((a, b) =>
      sort === 'bookings' ? b.bookingsTotal - a.bookingsTotal : b.leadsTotal - a.leadsTotal
    );

    const total = results.length;
    const offset = (pageNum - 1) * limitNum;

    return res.json({
      results: results.slice(offset, offset + limitNum),
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) || 1 },
    });
  } catch (err) {
    return next(err);
  }
};

exports.reviewProvider = async (req, res, next) => {
  try {
    const { decision, reason } = req.body;
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ message: 'Décision invalide (approve ou reject).' });
    }
    if (decision === 'reject' && !reason) {
      return res.status(400).json({ message: 'Un motif est requis pour un rejet.' });
    }

    const listing = await Listing.findByPk(req.params.listingId, {
      include: [{ model: User, as: 'owner' }],
    });
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }

    if (decision === 'approve') {
      listing.status = 'active';
      listing.rejectReason = null;
      await listing.save();
      await emailService.sendProviderApprovedEmail(listing.owner, listing);
    } else {
      listing.status = 'rejected';
      listing.rejectReason = reason;
      await listing.save();
      await emailService.sendProviderRejectedEmail(listing.owner, listing, reason);
    }

    return res.json(listing);
  } catch (err) {
    return next(err);
  }
};

// Onboarding assisté : l'admin crée le compte ET la fiche à la place d'un
// prestataire peu digitalisé recruté sur le terrain. La fiche est active
// immédiatement (validée de facto par l'admin qui la saisit).
exports.createProvider = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const {
    firstName,
    lastName,
    email,
    phone,
    title,
    description,
    categoryId,
    city,
    address,
    businessPhone,
    taxId,
    connectionFeeTermsAccepted,
  } = req.body;

  try {
    const existingEmail = await User.findOne({ where: { email } });
    if (existingEmail) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé.' });
    }

    if (phone) {
      const existingPhone = await User.findOne({ where: { phone } });
      if (existingPhone) {
        return res.status(409).json({ message: 'Ce numéro de téléphone est déjà utilisé.' });
      }
    }

    const category = await Category.findByPk(categoryId);
    if (!category) {
      return res.status(400).json({ message: 'Catégorie invalide.' });
    }

    // Frais de mise en relation (M13) : categorie concernee -> acceptation
    // des conditions obligatoire (case cochee par l'admin, accord recueilli
    // aupres du prestataire), date + version enregistrees sur la fiche.
    const feeCategory = await connectionFeeService.resolveFeeCategoryById(categoryId);
    const termsAccepted = connectionFeeTermsAccepted === true || connectionFeeTermsAccepted === 'true';
    if (feeCategory && !termsAccepted) {
      return res.status(400).json({
        message:
          "Cette catégorie est soumise aux frais de mise en relation : l'acceptation des conditions par le prestataire est obligatoire.",
      });
    }

    // Toutes les photos et le document CIN sont vérifiés AVANT toute écriture
    // en base : on ne veut jamais d'un compte/fiche créé avec des fichiers
    // partiellement rejetés.
    const files = req.files?.photos || [];
    for (const file of files) {
      if (!detectRealMimeType(file.buffer)) {
        return res
          .status(400)
          .json({ message: 'Une des photos est invalide. Utilisez JPG ou PNG.' });
      }
    }

    const cinFile = req.files?.cinDocument?.[0];
    if (cinFile && !detectRealMimeType(cinFile.buffer)) {
      return res
        .status(400)
        .json({ message: 'La carte CIN est invalide. Utilisez JPG ou PNG.' });
    }

    // Mot de passe temporaire lisible, communiqué directement par l'admin au
    // prestataire (oralement, SMS, WhatsApp...) : pas de lien par email, le
    // prestataire le change lui-même dès sa première connexion.
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);

    const user = await User.create({
      role: 'provider',
      firstName,
      lastName,
      email,
      phone,
      passwordHash,
      emailVerified: true, // identité vouchée par l'admin lors de l'onboarding
    });

    // Carte CIN : reference privee stockee telle quelle (PAS une URL
    // publique) - jamais servie statiquement, voir middleware/upload.js.
    const cinDocumentUrl = cinFile ? await storeLegalImage(cinFile.buffer) : null;

    const slug = await generateUniqueListingSlug(Listing, title);
    const listing = await Listing.create({
      userId: user.id,
      categoryId,
      title,
      slug,
      description,
      city,
      address,
      phone: businessPhone,
      taxId: taxId || null,
      cinDocumentUrl,
      status: 'active',
      connectionFeeTermsAcceptedAt: feeCategory && termsAccepted ? new Date() : null,
      connectionFeeTermsVersion: feeCategory && termsAccepted ? connectionFeeService.TERMS_VERSION : null,
    });

    // Abonnement Starter par defaut (gratuit) — US-P10, MODULES.md M9.
    await Subscription.create({
      userId: user.id,
      plan: 'starter',
      price: PLAN_CATALOG.starter.price,
      billingCycle: 'monthly',
      status: 'active',
      startDate: new Date().toISOString().slice(0, 10),
    });

    for (let i = 0; i < files.length; i += 1) {
      const url = await storeVerifiedImage(files[i].buffer);
      await Image.create({
        listingId: listing.id,
        url,
        isPrimary: i === 0,
        sortOrder: i,
      });
    }

    // Best-effort (comme les autres emails systeme, cf. emailService.sendMail) :
    // ne bloque jamais la creation si l'envoi echoue, le mot de passe reste
    // affiche/copiable dans la reponse pour une communication manuelle.
    await emailService.sendProviderAccountCreatedEmail(user, listing, temporaryPassword);

    return res.status(201).json({
      message:
        'Prestataire créé et fiche active. Ses identifiants lui ont été envoyés par email ; vous pouvez aussi les lui communiquer directement.',
      user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email },
      temporaryPassword,
      listing,
    });
  } catch (err) {
    return next(err);
  }
};

const EDITABLE_PROVIDER_FIELDS = [
  'title',
  'description',
  'categoryId',
  'city',
  'address',
  'phone',
  'priceFrom',
  'priceTo',
  'avgSpent',
  'capacity',
  'website',
  'facebookUrl',
  'instagramUrl',
  'yearsExperience',
  'languages',
  'taxId',
];

// Coordonnees du gerant (compte User proprietaire de la fiche), modifiables
// depuis le meme formulaire admin : champ du formulaire -> champ User.
const EDITABLE_OWNER_FIELDS = {
  ownerFirstName: 'firstName',
  ownerLastName: 'lastName',
  ownerEmail: 'email',
  ownerPhone: 'phone',
};

// --- Gestion du cycle de vie d'une fiche (Super Admin / Moderateur) --------

// Modification libre d'une fiche par l'admin (Super Admin uniquement).
exports.updateProvider = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await Listing.findByPk(req.params.id, {
      include: [{ model: User, as: 'owner' }],
    });
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }

    if (req.body.categoryId !== undefined) {
      const category = await Category.findByPk(req.body.categoryId);
      if (!category) {
        return res.status(400).json({ message: 'Catégorie invalide.' });
      }
    }

    // Email/telephone du gerant uniques sur toute la plateforme (contraintes
    // UNIQUE de la table users) : conflit explicite (409) plutot qu'une
    // erreur SQL generique.
    const owner = listing.owner;
    if (owner) {
      const { ownerEmail, ownerPhone } = req.body;
      if (ownerEmail && ownerEmail !== owner.email) {
        const taken = await User.findOne({ where: { email: ownerEmail, id: { [Op.ne]: owner.id } } });
        if (taken) return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
      }
      if (ownerPhone && ownerPhone !== owner.phone) {
        const taken = await User.findOne({ where: { phone: ownerPhone, id: { [Op.ne]: owner.id } } });
        if (taken) return res.status(409).json({ message: 'Ce téléphone est déjà utilisé par un autre compte.' });
      }
    }

    EDITABLE_PROVIDER_FIELDS.forEach((field) => {
      if (req.body[field] !== undefined) {
        listing[field] = field === 'taxId' ? req.body[field] || null : req.body[field];
      }
    });

    if (owner) {
      Object.entries(EDITABLE_OWNER_FIELDS).forEach(([bodyField, userField]) => {
        if (req.body[bodyField] !== undefined) {
          owner[userField] = userField === 'phone' ? req.body[bodyField] || null : req.body[bodyField];
        }
      });
      await owner.save();
    }

    await listing.save();

    return res.json(listing);
  } catch (err) {
    return next(err);
  }
};

// Activation / desactivation (Super Admin + Moderateur) : motif optionnel,
// email automatique au prestataire a chaque changement.
// --- Carte CIN du gerant (document legal sensible, CLAUDE.md) ---------------
// Stockee en prive (Cloudinary "authenticated", ou private-uploads/legal en
// local - jamais servie statiquement) : consultable uniquement via ces routes
// admin authentifiees. listing.cinDocumentUrl ne contient qu'une reference.
exports.getProviderCin = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id, { paranoid: false });
    const file = await readPrivateFile(listing?.cinDocumentUrl, LEGAL_FOLDER);
    if (!file) {
      return res.status(404).json({ message: 'Aucune carte CIN enregistrée.' });
    }
    res.set('Cache-Control', 'no-store');
    res.type(file.contentType);
    return res.send(file.buffer);
  } catch (err) {
    return next(err);
  }
};

exports.uploadProviderCin = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'Aucun fichier reçu.' });
    }
    // Type reel verifie (magic bytes), pas seulement l'extension.
    const cinRef = await storeLegalImage(req.file.buffer);
    if (!cinRef) {
      return res.status(400).json({ message: 'La carte CIN est invalide. Utilisez JPG ou PNG.' });
    }

    const previous = listing.cinDocumentUrl;
    listing.cinDocumentUrl = cinRef;
    await listing.save();
    deletePrivateFile(previous, LEGAL_FOLDER);

    return res.json({ message: 'Carte CIN enregistrée.', hasCinDocument: true });
  } catch (err) {
    return next(err);
  }
};

exports.deleteProviderCin = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }
    const previous = listing.cinDocumentUrl;
    listing.cinDocumentUrl = null;
    await listing.save();
    deletePrivateFile(previous, LEGAL_FOLDER);

    return res.json({ message: 'Carte CIN supprimée.', hasCinDocument: false });
  } catch (err) {
    return next(err);
  }
};

exports.updateProviderStatus = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { status, reason } = req.body;

  try {
    const listing = await Listing.findByPk(req.params.id, {
      include: [{ model: User, as: 'owner' }],
    });
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }

    listing.status = status;
    listing.rejectReason = status === 'suspended' ? reason || null : null;
    await listing.save();

    await emailService.sendProviderStatusChangedEmail(listing.owner, listing, status, reason);

    return res.json(listing);
  } catch (err) {
    return next(err);
  }
};

// Reinitialisation du mot de passe d'un prestataire par un admin (Super
// Admin) - meme generateur de mot de passe temporaire lisible que
// createProvider. Email best-effort (comme les autres emails systeme) : le
// mot de passe reste renvoye dans la reponse pour communication manuelle si
// l'envoi echoue.
exports.resetProviderPassword = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id, {
      include: [{ model: User, as: 'owner' }],
    });
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }

    const temporaryPassword = generateTemporaryPassword();
    listing.owner.passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);
    await listing.owner.save();

    await emailService.sendProviderPasswordResetEmail(listing.owner, temporaryPassword);

    return res.json({
      message:
        'Mot de passe réinitialisé. Il a été envoyé par email au prestataire ; vous pouvez aussi le lui communiquer directement.',
      temporaryPassword,
    });
  } catch (err) {
    return next(err);
  }
};

// Suppression = soft delete uniquement (Super Admin) : deleted_at = now() +
// statut suspended. La ligne n'est jamais supprimee, leads/avis/factures liés
// restent intacts. Reversible via restoreProvider.
exports.softDeleteProvider = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }

    listing.status = 'suspended';
    await listing.save();
    await listing.destroy(); // paranoid:true => soft delete (deleted_at), jamais de DELETE definitif

    return res.json({ message: 'Fiche supprimée (déplacée dans les prestataires supprimés).' });
  } catch (err) {
    return next(err);
  }
};

// Restauration d'une fiche soft-deleted (Super Admin).
exports.restoreProvider = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id, { paranoid: false });
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }
    if (!listing.deletedAt) {
      return res.status(409).json({ message: "Cette fiche n'est pas supprimée." });
    }

    await listing.restore();

    return res.json(listing);
  } catch (err) {
    return next(err);
  }
};

// Suppression DEFINITIVE (Super Admin) - irreversible, contrairement a
// softDeleteProvider : supprime la fiche ET toutes ses donnees liees
// (demandes, avis, reservations, clients CRM, contrats, factures...), voir
// providerPurgeService. Garde-fous : uniquement une fiche deja dans
// "Supprimés", et confirmation obligatoire en ressaisissant son nom exact
// (confirmTitle) - l'inventaire est montre avant via forceDeletePreview.
async function findDeletedListing(req, res) {
  const listing = await Listing.findByPk(req.params.id, { paranoid: false });
  if (!listing) {
    res.status(404).json({ message: 'Fiche introuvable.' });
    return null;
  }
  if (!listing.deletedAt) {
    res.status(409).json({ message: "Cette fiche doit d'abord être supprimée avant une suppression définitive." });
    return null;
  }
  return listing;
}

exports.forceDeletePreview = async (req, res, next) => {
  try {
    const listing = await findDeletedListing(req, res);
    if (!listing) return;
    const preview = await providerPurgeService.previewPurge(listing);
    return res.json({ title: listing.title, ...preview });
  } catch (err) {
    return next(err);
  }
};

exports.forceDeleteProvider = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await findDeletedListing(req, res);
    if (!listing) return;

    const confirmTitle = String(req.body?.confirmTitle ?? '').trim();
    if (confirmTitle !== listing.title.trim()) {
      return res.status(400).json({
        message: 'Confirmation incorrecte : saisissez exactement le nom de la fiche pour la supprimer définitivement.',
      });
    }

    await providerPurgeService.purgeListing(listing, {
      deleteOwnerAccount: req.body?.deleteOwnerAccount === true,
    });

    return res.json({ message: 'Fiche et données liées supprimées définitivement.' });
  } catch (err) {
    return next(err);
  }
};

// Liste des fiches soft-deleted (onglet admin "Supprimés").
exports.getDeletedProviders = async (req, res, next) => {
  try {
    const listings = await Listing.findAll({
      where: { deletedAt: { [Op.ne]: null } },
      paranoid: false,
      include: [
        {
          model: User,
          as: 'owner',
          attributes: ['id', 'firstName', 'lastName', 'email', 'phone'],
        },
        { model: Category, as: 'category', attributes: ['id', 'name'] },
      ],
      order: [['deletedAt', 'DESC']],
    });

    return res.json(listings);
  } catch (err) {
    return next(err);
  }
};

// Attribution manuelle d'un plan a un prestataire (US-A05 : offre fondateur,
// ou activation apres reglement hors plateforme recu par l'admin). Applique
// immediatement, comme le changement de plan cote prestataire.
exports.updateProviderSubscription = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { plan, billingCycle, status, startDate, endDate, price, paymentReference, notes } = req.body;

  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }

    const [subscription] = await Subscription.findOrCreate({
      where: { userId: listing.userId },
      defaults: {
        userId: listing.userId,
        plan: 'starter',
        price: PLAN_CATALOG.starter.price,
        billingCycle: 'monthly',
        status: 'active',
        startDate: new Date().toISOString().slice(0, 10),
        endDate: null,
      },
    });

    const cycle = billingCycle || subscription.billingCycle || 'monthly';
    const today = new Date().toISOString().slice(0, 10);
    const planChanged = plan !== undefined && plan !== subscription.plan;

    if (plan !== undefined) subscription.plan = plan;
    if (billingCycle !== undefined) subscription.billingCycle = billingCycle;
    if (status !== undefined) subscription.status = status;

    // Valeur explicite (formulaire admin) prioritaire ; sinon recalcul
    // automatique uniquement si le plan a change (comportement historique) -
    // a partir du tarif annuel du catalogue si le cycle choisi est "yearly",
    // sinon le tarif mensuel (Parametres admin > Plans & Tarifs).
    if (price !== undefined) {
      subscription.price = price;
    } else if (planChanged) {
      subscription.price = cycle === 'yearly' ? PLAN_CATALOG[plan].priceYearly : PLAN_CATALOG[plan].price;
    }

    if (startDate !== undefined) {
      subscription.startDate = startDate;
    } else if (planChanged) {
      subscription.startDate = today;
    }

    if (endDate !== undefined) {
      subscription.endDate = endDate || null;
    } else if (planChanged) {
      subscription.endDate = plan === 'starter' ? null : addInterval(subscription.startDate, cycle);
    }

    if (paymentReference !== undefined) subscription.paymentReference = paymentReference || null;
    if (notes !== undefined) subscription.notes = notes || null;

    subscription.reminderSentAt = null;
    await subscription.save();

    return res.json(subscription);
  } catch (err) {
    return next(err);
  }
};

exports.suspendListing = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }

    listing.status = 'suspended';
    await listing.save();

    return res.json(listing);
  } catch (err) {
    return next(err);
  }
};

exports.reactivateListing = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }

    listing.status = 'active';
    await listing.save();

    return res.json(listing);
  } catch (err) {
    return next(err);
  }
};

// --- Tableau de bord global (US-A02) --------------------------------------

exports.getDashboardStats = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const dateWhere = {};
    if (startDate) dateWhere[Op.gte] = new Date(startDate);
    if (endDate) dateWhere[Op.lte] = new Date(`${endDate}T23:59:59.999`);
    const leadsWhere = Object.keys(dateWhere).length > 0 ? { createdAt: dateWhere } : {};

    const [
      providersCount,
      clientsCount,
      activeListingsCount,
      pendingListingsCount,
      leadsCount,
      activeSubscriptions,
    ] = await Promise.all([
      User.count({ where: { role: 'provider' } }),
      User.count({ where: { role: 'client' } }),
      Listing.count({ where: { status: 'active' } }),
      Listing.count({ where: { status: 'pending' } }),
      Lead.count({ where: leadsWhere }),
      Subscription.findAll({ where: { status: 'active' } }),
    ]);

    const subscriptionRevenue = activeSubscriptions.reduce((sum, s) => sum + Number(s.price), 0);

    return res.json({
      providersCount,
      clientsCount,
      activeListingsCount,
      pendingListingsCount,
      leadsCount,
      activeSubscriptionsCount: activeSubscriptions.length,
      subscriptionRevenue,
      period: { startDate: startDate || null, endDate: endDate || null },
    });
  } catch (err) {
    return next(err);
  }
};

// --- Gestion des litiges (US-A03) ------------------------------------------

exports.getDisputes = async (req, res, next) => {
  try {
    const { status } = req.query;
    const where = {};
    if (status) where.status = status;

    const disputes = await Dispute.findAll({
      where,
      include: [
        { model: User, as: 'reporter', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: Listing, as: 'listing', attributes: ['id', 'title'] },
        { model: Review, as: 'review', attributes: ['id', 'rating', 'comment', 'isReported'] },
      ],
      order: [['createdAt', 'DESC']],
    });

    return res.json(disputes);
  } catch (err) {
    return next(err);
  }
};

exports.getDispute = async (req, res, next) => {
  try {
    const dispute = await Dispute.findByPk(req.params.id, {
      include: [
        { model: User, as: 'reporter', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: Listing, as: 'listing' },
        {
          model: Review,
          as: 'review',
          include: [
            { model: User, as: 'author', attributes: ['id', 'firstName'], required: false },
            { model: ReviewPhoto, as: 'photos' },
          ],
        },
      ],
    });

    if (!dispute) {
      return res.status(404).json({ message: 'Litige introuvable.' });
    }

    return res.json(dispute);
  } catch (err) {
    return next(err);
  }
};

exports.updateDispute = async (req, res, next) => {
  try {
    const { status, resolution } = req.body;
    if (status !== undefined && !VALID_DISPUTE_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Statut invalide.' });
    }

    const dispute = await Dispute.findByPk(req.params.id);
    if (!dispute) {
      return res.status(404).json({ message: 'Litige introuvable.' });
    }

    if (status !== undefined) {
      dispute.status = status;
      if (['resolved', 'rejected'].includes(status)) {
        dispute.resolvedAt = new Date();
      }
    }
    if (resolution !== undefined) dispute.resolution = resolution;
    await dispute.save();

    return res.json(dispute);
  } catch (err) {
    return next(err);
  }
};

// --- Modération des avis signalés (US-A04) ---------------------------------

exports.getReportedReviews = async (req, res, next) => {
  try {
    const reviews = await Review.findAll({
      where: { isReported: true },
      include: [
        { model: User, as: 'author', attributes: ['id', 'firstName', 'lastName'], required: false },
        { model: Listing, as: 'listing', attributes: ['id', 'title'] },
        { model: ReviewPhoto, as: 'photos' },
      ],
      order: [['createdAt', 'DESC']],
    });

    return res.json(reviews);
  } catch (err) {
    return next(err);
  }
};

exports.dismissReviewReport = async (req, res, next) => {
  try {
    const review = await Review.findByPk(req.params.id);
    if (!review) {
      return res.status(404).json({ message: 'Avis introuvable.' });
    }

    review.isReported = false;
    await review.save();

    await Dispute.update(
      {
        status: 'rejected',
        resolution: 'Signalement examiné : avis conservé.',
        resolvedAt: new Date(),
      },
      { where: { reviewId: review.id, status: { [Op.ne]: 'resolved' } } }
    );

    return res.json(review);
  } catch (err) {
    return next(err);
  }
};

exports.deleteReportedReview = async (req, res, next) => {
  try {
    const review = await Review.findByPk(req.params.id);
    if (!review) {
      return res.status(404).json({ message: 'Avis introuvable.' });
    }

    const { listingId } = review;

    // Résout les litiges AVANT la suppression : détruire l'avis déclenche le
    // ON DELETE SET NULL sur disputes.review_id, ce qui rendrait le where
    // ci-dessous incapable de retrouver les litiges liés une fois l'avis parti.
    await Dispute.update(
      { status: 'resolved', resolution: 'Avis frauduleux supprimé.', resolvedAt: new Date() },
      { where: { reviewId: review.id, status: { [Op.ne]: 'resolved' } } }
    );

    await review.destroy();
    await reviewService.recalculateListingRating(listingId);

    return res.json({ message: 'Avis supprimé.' });
  } catch (err) {
    return next(err);
  }
};

// --- Plans & Tarifs (Parametres admin) --------------------------------------
// Catalogue persiste en base (table `plans`) pour etre modifiable depuis
// l'interface, mais PLAN_CATALOG (planService) reste la source lue par le
// reste de l'app - toute modification ici la met a jour immediatement (voir
// updatePlanCatalogEntry) pour eviter un redemarrage serveur.

exports.getPlans = async (req, res, next) => {
  try {
    const plans = await Plan.findAll({ order: [['price', 'ASC']] });
    return res.json(
      plans.map((p) => ({
        key: p.key,
        label: p.label,
        description: p.description || '',
        price: Number(p.price),
        priceYearly: Number(p.priceYearly),
        maxPhotos: p.maxPhotos,
        maxVideos: p.maxVideos,
        maxPromotions: p.maxPromotions,
        featured: p.featured,
        eventsEnabled: p.eventsEnabled,
        calendarEnabled: p.calendarEnabled,
        maxVehicles: p.maxVehicles,
        maxCategories: p.maxCategories,
      }))
    );
  } catch (err) {
    return next(err);
  }
};

exports.updatePlan = async (req, res, next) => {
  try {
    const { key } = req.params;
    if (!VALID_PLANS.includes(key)) {
      return res.status(404).json({ message: 'Plan introuvable.' });
    }

    const plan = await Plan.findByPk(key);
    if (!plan) {
      return res.status(404).json({ message: 'Plan introuvable.' });
    }

    const {
      label,
      description,
      price,
      priceYearly,
      maxPhotos,
      maxVideos,
      maxPromotions,
      featured,
      eventsEnabled,
      calendarEnabled,
      maxVehicles,
      maxCategories,
    } = req.body;
    if (label !== undefined) plan.label = label;
    if (description !== undefined) plan.description = description;
    if (price !== undefined) plan.price = price;
    if (priceYearly !== undefined) plan.priceYearly = priceYearly;
    if (maxPhotos !== undefined) plan.maxPhotos = maxPhotos;
    if (maxVideos !== undefined) plan.maxVideos = maxVideos;
    if (maxPromotions !== undefined) plan.maxPromotions = maxPromotions;
    if (featured !== undefined) plan.featured = featured;
    if (eventsEnabled !== undefined) plan.eventsEnabled = eventsEnabled;
    if (calendarEnabled !== undefined) plan.calendarEnabled = calendarEnabled;
    if (maxVehicles !== undefined) plan.maxVehicles = maxVehicles;
    if (maxCategories !== undefined) plan.maxCategories = maxCategories;
    await plan.save();

    updatePlanCatalogEntry(plan.key, plan);

    return res.json({
      key: plan.key,
      label: plan.label,
      description: plan.description || '',
      price: Number(plan.price),
      priceYearly: Number(plan.priceYearly),
      maxPhotos: plan.maxPhotos,
      maxVideos: plan.maxVideos,
      maxPromotions: plan.maxPromotions,
      featured: plan.featured,
      eventsEnabled: plan.eventsEnabled,
      calendarEnabled: plan.calendarEnabled,
      maxVehicles: plan.maxVehicles,
      maxCategories: plan.maxCategories,
    });
  } catch (err) {
    return next(err);
  }
};
