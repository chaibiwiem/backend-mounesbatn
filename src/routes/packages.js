const express = require('express');
const { body } = require('express-validator');
const packageController = require('../controllers/packageController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');
const { sanitizeFields } = require('../middleware/sanitize');

const router = express.Router();

const sanitizePackage = sanitizeFields(['name', 'description']);

const createPackageValidators = [
  body('name').trim().notEmpty().withMessage('Nom requis.').isLength({ max: 120 }),
  body('description').optional({ checkFalsy: true }).isLength({ max: 2000 }),
  body('price').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Prix invalide.').toFloat(),
  body('priceType').optional().isIn(['fixed', 'from', 'per_hour', 'on_quote']).withMessage('Type de prix invalide.'),
  body('duration').optional({ checkFalsy: true }).isLength({ max: 80 }),
];

const updatePackageValidators = [
  body('name').optional().trim().notEmpty().withMessage('Nom requis.').isLength({ max: 120 }),
  body('description').optional({ checkFalsy: true }).isLength({ max: 2000 }),
  body('price').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Prix invalide.').toFloat(),
  body('priceType').optional().isIn(['fixed', 'from', 'per_hour', 'on_quote']).withMessage('Type de prix invalide.'),
  body('duration').optional({ checkFalsy: true }).isLength({ max: 80 }),
];

router.post(
  '/',
  verifyToken,
  requireActiveProvider('provider'),
  sanitizePackage,
  createPackageValidators,
  packageController.createPackage
);
router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider'),
  sanitizePackage,
  updatePackageValidators,
  packageController.updatePackage
);
router.delete('/:id', verifyToken, requireActiveProvider('provider'), packageController.deletePackage);

module.exports = router;
