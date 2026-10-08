const express = require('express');
const { body } = require('express-validator');
const promotionController = require('../controllers/promotionController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');

const router = express.Router();

const createPromotionValidators = [
  body('type').isIn(['percent', 'fixed']).withMessage('Type de promotion invalide.'),
  body('value').isFloat({ min: 0 }).withMessage('Valeur invalide.').toFloat(),
  body('label').trim().notEmpty().withMessage('Libellé requis.').isLength({ max: 160 }),
  body('startDate').optional({ checkFalsy: true }).isISO8601().withMessage('Date de début invalide.'),
  body('endDate').optional({ checkFalsy: true }).isISO8601().withMessage('Date de fin invalide.'),
];

const updatePromotionValidators = [
  body('type').optional().isIn(['percent', 'fixed']).withMessage('Type de promotion invalide.'),
  body('value').optional().isFloat({ min: 0 }).withMessage('Valeur invalide.').toFloat(),
  body('label').optional().trim().notEmpty().withMessage('Libellé requis.').isLength({ max: 160 }),
  body('startDate').optional({ checkFalsy: true }).isISO8601().withMessage('Date de début invalide.'),
  body('endDate').optional({ checkFalsy: true }).isISO8601().withMessage('Date de fin invalide.'),
  body('isActive').optional().isBoolean().toBoolean(),
];

router.post(
  '/',
  verifyToken,
  requireActiveProvider('provider'),
  createPromotionValidators,
  promotionController.createPromotion
);
router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider'),
  updatePromotionValidators,
  promotionController.updatePromotion
);
router.delete('/:id', verifyToken, requireActiveProvider('provider'), promotionController.deletePromotion);

module.exports = router;
