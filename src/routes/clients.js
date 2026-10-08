const express = require('express');
const { body } = require('express-validator');
const clientController = require('../controllers/clientController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');

const router = express.Router();

const updateClientValidators = [
  body('totalAmount').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Montant invalide.').toFloat(),
  body('depositAmount').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Acompte invalide.').toFloat(),
  body('tag').optional().isIn(['nouveau', 'recurrent', 'vip']).withMessage('Tag invalide.'),
  body('notes').optional({ checkFalsy: true }).isLength({ max: 2000 }).withMessage('Notes trop longues.'),
];

// /export doit etre declare avant /:id pour ne pas etre capture par le parametre.
router.get('/export', verifyToken, requireActiveProvider('provider'), clientController.exportClients);
router.get('/', verifyToken, requireActiveProvider('provider'), clientController.getClients);
router.get('/:id', verifyToken, requireActiveProvider('provider'), clientController.getClient);
router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider'),
  updateClientValidators,
  clientController.updateClient
);
router.patch(
  '/:id/clear-manual-tag',
  verifyToken,
  requireActiveProvider('provider'),
  clientController.clearManualTag
);
router.delete('/:id', verifyToken, requireActiveProvider('provider'), clientController.deleteClient);

module.exports = router;
