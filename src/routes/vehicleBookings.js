const express = require('express');
const { body } = require('express-validator');
const vehicleBookingController = require('../controllers/vehicleBookingController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');

const router = express.Router();

const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];
const PAYMENT_METHODS = ['cash', 'rib'];

const updateVehicleBookingValidators = [
  body('departureDatetime').optional({ checkFalsy: true }).isISO8601().withMessage('Date de départ invalide.'),
  body('returnDatetime').optional({ checkFalsy: true }).isISO8601().withMessage('Date de retour invalide.'),
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
  updateVehicleBookingValidators,
  vehicleBookingController.updateVehicleBooking
);

router.patch(
  '/:id/status',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  body('status').notEmpty().isIn(BOOKING_STATUSES),
  vehicleBookingController.updateVehicleBookingStatus
);

module.exports = router;
