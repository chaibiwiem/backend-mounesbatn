const express = require('express');
const { body } = require('express-validator');
const contractController = require('../controllers/contractController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');

const router = express.Router();

const createContractValidators = [
  body('clientId').notEmpty().withMessage('Client requis.').isInt({ min: 1 }).toInt(),
  body('object').trim().notEmpty().withMessage("L'objet du contrat est requis.").isLength({ max: 255 }),
  body('amount').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Montant invalide.').toFloat(),
  body('deposit').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Acompte invalide.').toFloat(),
  body('paymentMode').optional({ checkFalsy: true }).isIn(['cash', 'rib']).withMessage('Mode de règlement invalide.'),
  body('terms').optional({ checkFalsy: true }).isLength({ max: 5000 }),
];

const updateContractValidators = [
  body('object').optional({ checkFalsy: true }).isLength({ max: 255 }),
  body('amount').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Montant invalide.').toFloat(),
  body('deposit').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Acompte invalide.').toFloat(),
  body('paymentMode').optional({ checkFalsy: true }).isIn(['cash', 'rib']).withMessage('Mode de règlement invalide.'),
  body('terms').optional({ checkFalsy: true }).isLength({ max: 5000 }),
  body('status').optional().isIn(['draft', 'sent', 'signed', 'cancelled']).withMessage('Statut invalide.'),
];

router.get('/', verifyToken, requireActiveProvider('provider'), contractController.getContracts);
router.post(
  '/',
  verifyToken,
  requireActiveProvider('provider'),
  createContractValidators,
  contractController.createContract
);
router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider'),
  updateContractValidators,
  contractController.updateContract
);
router.post('/:id/send', verifyToken, requireActiveProvider('provider'), contractController.sendContract);

module.exports = router;
