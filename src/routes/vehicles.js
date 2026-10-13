const express = require('express');
const { body } = require('express-validator');
const vehicleController = require('../controllers/vehicleController');
const vehicleBookingController = require('../controllers/vehicleBookingController');
const vehicleDecorationController = require('../controllers/vehicleDecorationController');
const vehicleOptionController = require('../controllers/vehicleOptionController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const router = express.Router();

const VEHICLE_TYPES = ['voiture', 'bus', 'minibus'];
const PAYMENT_METHODS = ['cash', 'rib'];
const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];

const updateVehicleValidators = [
  body('type').optional({ checkFalsy: true }).isIn(VEHICLE_TYPES).withMessage('Type de véhicule invalide.'),
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

const createVehicleDecorationValidators = [
  body('name').trim().notEmpty().isLength({ max: 120 }).withMessage('Nom du modèle requis.'),
  body('description').optional({ checkFalsy: true }).isLength({ max: 1000 }),
  body('price').optional({ checkFalsy: true }).isFloat({ min: 0 }),
];

const createVehicleOptionValidators = [
  body('name').trim().notEmpty().isLength({ max: 120 }).withMessage("Nom de l'option requis."),
  body('price').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  body('pricingType').optional({ checkFalsy: true }).isIn(['per_day', 'flat']),
  body('maxQuantity').optional({ checkFalsy: true }).isInt({ min: 1, max: 10 }).toInt(),
];

const createVehicleBookingValidators = [
  body('leadId').optional({ checkFalsy: true }).isInt().withMessage('Demande invalide.').toInt(),
  body('clientId').optional({ checkFalsy: true }).isInt().withMessage('Client invalide.').toInt(),
  body('clientName').optional({ checkFalsy: true }).trim().isLength({ max: 160 }),
  body('clientEmail').optional({ checkFalsy: true }).isEmail().withMessage('Email invalide.').normalizeEmail(),
  body('clientPhone')
    .optional({ checkFalsy: true })
    .customSanitizer((value) => String(value).replace(/\s/g, ''))
    .matches(/^\+?\d{8,15}$/)
    .withMessage('Téléphone invalide.'),
  body('departureDatetime').notEmpty().isISO8601().withMessage('Date de départ invalide.'),
  body('returnDatetime').notEmpty().isISO8601().withMessage('Date de retour invalide.'),
  body('totalPrice').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Montant invalide.'),
  body('deposit').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Acompte invalide.'),
  body('paymentMethod').optional({ checkFalsy: true }).isIn(PAYMENT_METHODS).withMessage('Mode de règlement invalide.'),
  body('status').optional({ checkFalsy: true }).isIn(BOOKING_STATUSES),
  body('notes').optional({ checkFalsy: true }).isLength({ max: 2000 }),
];

router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  upload.single('image'),
  updateVehicleValidators,
  vehicleController.updateVehicle
);
router.delete('/:id', verifyToken, requireActiveProvider('provider', 'admin'), vehicleController.deleteVehicle);

router.post(
  '/:id/decorations',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  upload.single('image'),
  createVehicleDecorationValidators,
  vehicleDecorationController.addDecoration
);

router.post(
  '/:id/options',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  createVehicleOptionValidators,
  vehicleOptionController.addOption
);

router.get('/:id/reserved-periods', vehicleBookingController.getPublicReservedPeriods);

router.get(
  '/:id/bookings',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  vehicleBookingController.getVehicleBookings
);
router.post(
  '/:id/bookings',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  createVehicleBookingValidators,
  vehicleBookingController.createVehicleBooking
);

module.exports = router;
