const express = require('express');
const { body } = require('express-validator');
const commissionController = require('../controllers/commissionController');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Frais de mise en relation (M13) : contestation par le prestataire
// proprietaire d'une ligne validee non facturee (verifie dans le controleur).
router.post(
  '/:id/dispute',
  verifyToken,
  requireRole('provider'),
  body('comment')
    .isString()
    .trim()
    .isLength({ min: 5, max: 500 })
    .withMessage('Expliquez votre contestation (5 à 500 caractères).'),
  commissionController.disputeCommission
);

module.exports = router;
