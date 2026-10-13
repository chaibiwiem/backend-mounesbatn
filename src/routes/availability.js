const express = require('express');
const { body } = require('express-validator');
const availabilityController = require('../controllers/availabilityController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');

const router = express.Router();

const upsertAvailabilityValidators = [
  body('date').isISO8601().withMessage('Date invalide.'),
  body('isAvailable').optional().isBoolean().withMessage('Disponibilité invalide.').toBoolean(),
  body('priceOverride').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Prix invalide.').toFloat(),
];

router.post(
  '/',
  verifyToken,
  requireActiveProvider('provider'),
  upsertAvailabilityValidators,
  availabilityController.upsertAvailability
);
router.delete('/:id', verifyToken, requireActiveProvider('provider'), availabilityController.deleteAvailability);

module.exports = router;
