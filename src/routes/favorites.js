const express = require('express');
const { body } = require('express-validator');
const favoriteController = require('../controllers/favoriteController');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken, requireRole('client'));

const addFavoriteValidators = [
  body('listingId').notEmpty().withMessage('Prestataire requis.').isInt({ min: 1 }).toInt(),
];

router.get('/me', favoriteController.getMyFavorites);
router.post('/', addFavoriteValidators, favoriteController.addFavorite);
router.delete('/:listingId', favoriteController.removeFavorite);

module.exports = router;
