const express = require('express');
const { body } = require('express-validator');
const listingController = require('../controllers/listingController');
const leadController = require('../controllers/leadController');
const bookingController = require('../controllers/bookingController');
const imageController = require('../controllers/imageController');
const videoController = require('../controllers/videoController');
const availabilityController = require('../controllers/availabilityController');
const promotionController = require('../controllers/promotionController');
const vehicleController = require('../controllers/vehicleController');
const vehicleBookingController = require('../controllers/vehicleBookingController');
const providerEventController = require('../controllers/providerEventController');
const calendarController = require('../controllers/calendarController');
const commissionController = require('../controllers/commissionController');
const { verifyToken, requireActiveProvider, optionalAuth, requireRole } = require('../middleware/auth');
const { sanitizeFields } = require('../middleware/sanitize');
const { safeUrlValidators } = require('../middleware/safeUrl');
const {
  upload,
  persistVerifiedImage,
  uploadVideoFields,
  uploadThumbnailOnly,
} = require('../middleware/upload');

const router = express.Router();

const createVehicleValidators = [
  body('type').notEmpty().isIn(['voiture', 'bus', 'minibus']).withMessage('Type de véhicule invalide.'),
  body('brand').optional({ checkFalsy: true }).trim().isLength({ max: 80 }),
  body('model').optional({ checkFalsy: true }).trim().isLength({ max: 80 }),
  body('year').optional({ checkFalsy: true }).isInt({ min: 1950, max: new Date().getFullYear() + 1 }).toInt(),
  body('seats').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).toInt(),
  body('doors').optional({ checkFalsy: true }).isInt({ min: 1, max: 10 }).toInt(),
  body('luggage').optional({ checkFalsy: true }).isInt({ min: 0, max: 50 }).toInt(),
  body('transmission')
    .optional({ checkFalsy: true })
    .isIn(['manuelle', 'automatique'])
    .withMessage('Boîte de vitesses invalide.'),
  body('pricePerDay').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  body('pricePerHour').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  body('hasDecoration').optional().isBoolean().toBoolean(),
  body('perksTitle').optional({ checkFalsy: true }).trim().isLength({ max: 255 }),
  body('description').optional({ checkFalsy: true }).isLength({ max: 2000 }),
];

const PROVIDER_EVENT_TYPES = [
  'portes_ouvertes',
  'show_cooking',
  'defile',
  'lancement',
  'degustation',
  'autre',
];

// "Mes evenements" (M5) : evenements organises PAR le prestataire pour
// montrer ses services en action - ne pas confondre avec les "types
// d'evenements" du client (mariage...), purement editoriaux (M3).
const createEventValidators = [
  body('title').trim().notEmpty().isLength({ max: 160 }).withMessage('Titre requis.'),
  body('type').optional({ checkFalsy: true }).isIn(PROVIDER_EVENT_TYPES).withMessage('Type invalide.'),
  body('description').optional({ checkFalsy: true }).isLength({ max: 2000 }),
  body('eventDate')
    .notEmpty()
    .withMessage('Date requise.')
    .isISO8601()
    .withMessage('Date invalide.')
    .custom((value) => {
      const today = new Date().toISOString().slice(0, 10);
      if (value.slice(0, 10) < today) {
        throw new Error("La date de l'événement ne peut pas être dans le passé.");
      }
      return true;
    }),
  body('startTime').optional({ checkFalsy: true }).matches(/^\d{2}:\d{2}(:\d{2})?$/).withMessage('Heure de début invalide.'),
  body('endTime')
    .optional({ checkFalsy: true })
    .matches(/^\d{2}:\d{2}(:\d{2})?$/)
    .withMessage('Heure de fin invalide.')
    .custom((value, { req }) => {
      if (req.body.startTime && value <= req.body.startTime) {
        throw new Error('L’heure de fin doit être postérieure à l’heure de début.');
      }
      return true;
    }),
  body('location').optional({ checkFalsy: true }).trim().isLength({ max: 255 }),
  body('isPublished').optional().isBoolean().toBoolean(),
];

// Routes "me" enregistrees avant "/:id" pour ne pas etre capturees par le
// parametre dynamique.
router.get('/me', verifyToken, requireActiveProvider('provider'), listingController.getMyListing);
router.patch(
  '/me',
  verifyToken,
  requireActiveProvider('provider'),
  sanitizeFields(['title', 'description']),
  safeUrlValidators,
  body('phone')
    .optional({ checkFalsy: true })
    .customSanitizer((value) => String(value).replace(/\s/g, ''))
    .matches(/^\+?\d{8,15}$/)
    .withMessage('Téléphone invalide.'),
  listingController.updateMyListing
);
router.post(
  '/me/images',
  verifyToken,
  requireActiveProvider('provider'),
  upload.single('image'),
  persistVerifiedImage,
  imageController.uploadImage
);
router.patch(
  '/me/images/reorder',
  verifyToken,
  requireActiveProvider('provider'),
  imageController.reorderImages
);
router.post(
  '/me/logo',
  verifyToken,
  requireActiveProvider('provider'),
  upload.single('logo'),
  persistVerifiedImage,
  listingController.uploadLogo
);
router.delete('/me/logo', verifyToken, requireActiveProvider('provider'), listingController.deleteLogo);

// Sous-categories supplementaires de la fiche (limite : Plan.maxCategories).
router.put(
  '/me/categories',
  verifyToken,
  requireActiveProvider('provider'),
  body('categoryIds').isArray().withMessage('Liste de catégories invalide.'),
  body('categoryIds.*').isInt({ min: 1 }).withMessage('Catégorie invalide.').toInt(),
  listingController.updateMyCategories
);

// Config email prestataire (M5, onglet "Email SMTP") : SMTP/Resend propre au
// prestataire pour l'envoi de factures/contrats a ses clients.
// Frais de mise en relation (M13) : acceptation des conditions par le
// prestataire lui-meme (date + version enregistrees).
router.post(
  '/me/connection-fee-terms',
  verifyToken,
  requireRole('provider'),
  body('accept').custom((value) => value === true).withMessage('Cochez la case pour accepter les conditions.'),
  commissionController.acceptTerms
);
router.get('/:id/commissions', verifyToken, commissionController.getListingCommissions);

router.get('/me/email-settings', verifyToken, requireActiveProvider('provider'), listingController.getMyEmailSettings);
router.patch(
  '/me/email-settings',
  verifyToken,
  requireActiveProvider('provider'),
  body('fromEmail').optional({ checkFalsy: true }).isEmail().withMessage("Adresse d'expédition invalide."),
  body('port').optional({ checkFalsy: true }).isInt({ min: 1, max: 65535 }).withMessage('Port invalide.'),
  listingController.updateMyEmailSettings
);
router.post('/me/email-settings/test', verifyToken, requireActiveProvider('provider'), listingController.sendMyTestEmail);

const addVideoLinkValidators = [
  body('url').trim().notEmpty().withMessage('Le lien de la vidéo est requis.').isURL().withMessage('Lien vidéo invalide.'),
  body('title').optional({ checkFalsy: true }).isLength({ max: 160 }),
];

const uploadVideoFileValidators = [body('title').optional({ checkFalsy: true }).isLength({ max: 160 })];

router.post(
  '/me/videos',
  verifyToken,
  requireActiveProvider('provider'),
  uploadThumbnailOnly.fields([{ name: 'thumbnail', maxCount: 1 }]),
  addVideoLinkValidators,
  videoController.addVideoLink
);
router.post(
  '/me/videos/upload',
  verifyToken,
  requireActiveProvider('provider'),
  uploadVideoFields.fields([
    { name: 'video', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
  ]),
  uploadVideoFileValidators,
  videoController.uploadVideoFile
);

router.get('/', optionalAuth, listingController.searchListings);
// Regroupe plusieurs categories en une seule requete (PrestatairesLanding) -
// place avant "/:id" pour ne pas etre capture par ce segment dynamique.
router.get('/by-categories', optionalAuth, listingController.searchListingsByCategories);
// URL publique SEO /:categorySlug/:listingSlug (frontend) -> resolue ici par
// le seul slug de la fiche (voir controller). Placee avant "/:id" par clarte,
// meme si le nombre de segments differents evite toute ambiguite de route.
router.get('/slug/:categorySlug/:listingSlug', optionalAuth, listingController.getListingDetailBySlug);
router.get('/:id', optionalAuth, listingController.getListingDetail);
router.get('/:id/similar', listingController.getSimilarListings);
router.get('/:id/leads', verifyToken, leadController.getListingLeads);
router.get('/:id/leads/export', verifyToken, leadController.exportListingLeads);
router.get('/:id/bookings', verifyToken, bookingController.getListingBookings);
router.get('/:id/calendar', verifyToken, calendarController.getCalendar);
router.get('/:id/vehicle-bookings', verifyToken, vehicleBookingController.getListingVehicleBookings);
router.get('/:id/availability', availabilityController.getAvailability);
router.get('/:id/promotions', promotionController.getListingPromotions);
router.get('/:id/videos', videoController.getListingVideos);
router.get('/:id/vehicles', vehicleController.getListingVehicles);
router.post(
  '/:id/vehicles',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  upload.single('image'),
  createVehicleValidators,
  vehicleController.addVehicle
);

router.get('/:id/events/public', providerEventController.getPublicListingEvents);
router.get('/:id/events/leads', verifyToken, requireActiveProvider('provider', 'admin'), leadController.getListingEventLeads);
router.get('/:id/events', verifyToken, requireActiveProvider('provider', 'admin'), providerEventController.getListingEvents);
router.post(
  '/:id/events',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  upload.single('image'),
  createEventValidators,
  providerEventController.createEvent
);

module.exports = router;
