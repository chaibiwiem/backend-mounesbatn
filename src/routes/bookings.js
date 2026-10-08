const express = require('express');
const { body } = require('express-validator');
const bookingController = require('../controllers/bookingController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');

const router = express.Router();

// Sejour "Maison d'hote" (Arrivee/Depart + chambres + invites) - memes regles
// que la demande de devis (routes/leads.js).
const stayValidators = [
  body('checkInDate').optional({ checkFalsy: true }).isISO8601().withMessage('Date d’arrivée invalide.'),
  body('checkOutDate')
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage('Date de départ invalide.')
    .custom((value, { req }) => {
      if (req.body.checkInDate && new Date(value) <= new Date(req.body.checkInDate)) {
        throw new Error('La date de départ doit être postérieure à la date d’arrivée.');
      }
      return true;
    }),
  body('rooms').optional({ nullable: true }).isArray().withMessage('Chambres invalides.'),
  body('rooms.*.adults').isInt({ min: 1 }).withMessage('Nombre d’adultes invalide.').toInt(),
  body('rooms.*.children').optional().isInt({ min: 0 }).withMessage('Nombre d’enfants invalide.').toInt(),
  body('rooms.*.babies').optional().isInt({ min: 0 }).withMessage('Nombre de lits bébé invalide.').toInt(),
  body('rooms.*.price')
    .optional({ checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage('Prix de chambre invalide.')
    .toFloat(),
  body('servicePrice')
    .optional({ checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage('Prix de la prestation invalide.')
    .toFloat(),
  body('discountType')
    .optional({ checkFalsy: true })
    .isIn(['amount', 'percent'])
    .withMessage('Type de remise invalide.'),
  body('discountValue')
    .optional({ checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage('Remise invalide.')
    .toFloat()
    .custom((value, { req }) => {
      if (req.body.discountType === 'percent' && value > 100) {
        throw new Error('La remise ne peut pas dépasser 100 %.');
      }
      return true;
    }),
  body('guests').optional({ checkFalsy: true }).isLength({ max: 40 }),
  body('packageId').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Pack invalide.').toInt(),
];

const createBookingValidators = [
  body('leadId').optional({ checkFalsy: true }).isInt().withMessage('Demande invalide.').toInt(),
  body('clientId').optional({ checkFalsy: true }).isInt().withMessage('Client invalide.').toInt(),
  body('clientName').optional({ checkFalsy: true }).trim().isLength({ max: 160 }),
  body('clientEmail').optional({ checkFalsy: true }).isEmail().withMessage('Email invalide.').normalizeEmail(),
  body('clientPhone')
    .optional({ checkFalsy: true })
    .customSanitizer((value) => String(value).replace(/\s/g, ''))
    .matches(/^\+?\d{8,15}$/)
    .withMessage('Téléphone invalide.'),
  body('eventDate').optional({ checkFalsy: true }).isISO8601().withMessage('Date invalide.'),
  body('startTime')
    .optional({ checkFalsy: true })
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage("Heure de début invalide (format HH:MM)."),
  body('endTime')
    .optional({ checkFalsy: true })
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage("Heure de fin invalide (format HH:MM)."),
  body('totalPrice').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Montant invalide.'),
  body('deposit').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Acompte invalide.'),
  body('paymentMethod').optional({ checkFalsy: true }).isIn(['cash', 'rib']).withMessage('Mode de règlement invalide.'),
  body('status').optional({ checkFalsy: true }).isIn(['pending', 'confirmed', 'completed', 'cancelled']),
  body('notes').optional({ checkFalsy: true }).isLength({ max: 2000 }),
  ...stayValidators,
];

const updateBookingValidators = [
  body('eventDate').optional({ checkFalsy: true }).isISO8601().withMessage('Date invalide.'),
  body('startTime')
    .optional({ checkFalsy: true })
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage("Heure de début invalide (format HH:MM)."),
  body('endTime')
    .optional({ checkFalsy: true })
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage("Heure de fin invalide (format HH:MM)."),
  body('totalPrice').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Montant invalide.'),
  body('deposit').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Acompte invalide.'),
  body('paymentMethod').optional({ checkFalsy: true }).isIn(['cash', 'rib']).withMessage('Mode de règlement invalide.'),
  body('status').optional({ checkFalsy: true }).isIn(['pending', 'confirmed', 'completed', 'cancelled']),
  body('notes').optional({ checkFalsy: true }).isLength({ max: 2000 }),
  ...stayValidators,
];

router.get('/me', verifyToken, bookingController.getMyBookings);
router.post(
  '/',
  verifyToken,
  requireActiveProvider('provider'),
  createBookingValidators,
  bookingController.createBooking
);
router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider'),
  updateBookingValidators,
  bookingController.updateBooking
);
router.patch(
  '/:id/status',
  verifyToken,
  requireActiveProvider('provider'),
  body('status').notEmpty().isIn(['pending', 'confirmed', 'completed', 'cancelled']),
  bookingController.updateBookingStatus
);
router.delete('/:id', verifyToken, requireActiveProvider('provider'), bookingController.deleteBooking);

// Self-service client (espace client > Mes réservations) - toute personne
// connectee peut appeler ces routes, l'autorisation reelle (proprietaire de
// la reservation) est verifiee dans loadOwnBookingOrRespond.
router.patch('/:id/cancel', verifyToken, bookingController.cancelMyBooking);
router.patch(
  '/:id/date',
  verifyToken,
  body('eventDate').notEmpty().isISO8601().withMessage('Date invalide.'),
  bookingController.updateMyBookingDate
);

module.exports = router;
