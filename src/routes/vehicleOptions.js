const express = require('express');
const { body } = require('express-validator');
const vehicleOptionController = require('../controllers/vehicleOptionController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');

const router = express.Router();

const updateVehicleOptionValidators = [
  body('name').optional({ checkFalsy: true }).trim().isLength({ max: 120 }),
  body('price').optional().isFloat({ min: 0 }),
  body('pricingType').optional({ checkFalsy: true }).isIn(['per_day', 'flat']),
  body('maxQuantity').optional().isInt({ min: 1, max: 10 }).toInt(),
];

router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  updateVehicleOptionValidators,
  vehicleOptionController.updateOption
);
router.delete('/:id', verifyToken, requireActiveProvider('provider', 'admin'), vehicleOptionController.deleteOption);

module.exports = router;
