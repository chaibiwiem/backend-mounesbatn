const express = require('express');
const { body } = require('express-validator');
const invoiceController = require('../controllers/invoiceController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');

const router = express.Router();

const createInvoiceValidators = [
  body('clientId').optional({ checkFalsy: true }).isInt({ min: 1 }).toInt(),
  body('bookingId').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Réservation invalide.').toInt(),
  body('description').optional({ checkFalsy: true }).isLength({ max: 2000 }),
  body('amount').notEmpty().withMessage('Le montant est requis.').isFloat({ min: 0 }).withMessage('Montant invalide.').toFloat(),
  body('taxRate').optional({ checkFalsy: true }).isFloat({ min: 0, max: 100 }).withMessage('Le taux de TVA doit être compris entre 0 et 100.').toFloat(),
  body('deposit').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Acompte invalide.').toFloat(),
  body('issuedAt').optional({ checkFalsy: true }).isISO8601().withMessage('Date invalide.'),
];

const updateInvoiceValidators = [
  body('clientId').optional({ checkFalsy: true }).isInt({ min: 1 }).toInt(),
  body('bookingId').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Réservation invalide.').toInt(),
  body('description').optional({ checkFalsy: true }).isLength({ max: 2000 }),
  body('amount').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Montant invalide.').toFloat(),
  body('taxRate').optional({ checkFalsy: true }).isFloat({ min: 0, max: 100 }).withMessage('Le taux de TVA doit être compris entre 0 et 100.').toFloat(),
  body('deposit').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Acompte invalide.').toFloat(),
  body('issuedAt').optional({ checkFalsy: true }).isISO8601().withMessage('Date invalide.'),
  body('status').optional().isIn(['unpaid', 'paid', 'cancelled']).withMessage('Statut invalide.'),
];

const updateInvoiceStatusValidators = [
  body('status').isIn(['unpaid', 'paid', 'cancelled']).withMessage('Statut invalide.'),
];

router.get('/', verifyToken, requireActiveProvider('provider'), invoiceController.getInvoices);
router.post(
  '/',
  verifyToken,
  requireActiveProvider('provider'),
  createInvoiceValidators,
  invoiceController.createInvoice
);
router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider'),
  updateInvoiceValidators,
  invoiceController.updateInvoice
);
router.patch(
  '/:id/status',
  verifyToken,
  requireActiveProvider('provider'),
  updateInvoiceStatusValidators,
  invoiceController.updateInvoiceStatus
);
router.post('/:id/send', verifyToken, requireActiveProvider('provider'), invoiceController.sendInvoice);

module.exports = router;
