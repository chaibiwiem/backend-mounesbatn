const express = require('express');
const { body } = require('express-validator');
const vehicleDecorationController = require('../controllers/vehicleDecorationController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const router = express.Router();

const updateVehicleDecorationValidators = [
  body('name').optional({ checkFalsy: true }).trim().isLength({ max: 120 }),
  body('description').optional({ checkFalsy: true }).isLength({ max: 1000 }),
  body('price').optional().isFloat({ min: 0 }),
];

router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  upload.single('image'),
  updateVehicleDecorationValidators,
  vehicleDecorationController.updateDecoration
);
router.delete(
  '/:id',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  vehicleDecorationController.deleteDecoration
);

module.exports = router;
