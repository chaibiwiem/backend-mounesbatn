const express = require('express');
const { body } = require('express-validator');
const reviewController = require('../controllers/reviewController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { sanitizeFields } = require('../middleware/sanitize');

const router = express.Router();

const createReviewValidators = [
  body('bookingId').optional({ checkFalsy: true }).isInt({ min: 1 }).toInt(),
  body('listingId').optional({ checkFalsy: true }).isInt({ min: 1 }).toInt(),
  body('title').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('comment').optional({ checkFalsy: true }).isLength({ max: 5000 }),
];

const replyValidators = [body('reply').trim().notEmpty().withMessage('La réponse ne peut pas être vide.').isLength({ max: 2000 })];

const reportReviewValidators = [
  body('type').optional().isIn(['no_show', 'misleading', 'fake_review', 'other']).withMessage('Type de signalement invalide.'),
  body('description').optional({ checkFalsy: true }).isLength({ max: 2000 }),
];

// Reserve aux clients connectes (avis avec ou sans reservation - decision
// produit) : un visiteur doit se connecter ou creer son compte d'abord.
// sanitizeFields apres upload.array (multer) : req.body n'est peuple qu'une
// fois le multipart/form-data parse.
router.post(
  '/',
  verifyToken,
  upload.array('photos', 5),
  sanitizeFields(['comment', 'title']),
  createReviewValidators,
  reviewController.createReview
);
router.patch(
  '/:id/reply',
  verifyToken,
  requireActiveProvider('provider'),
  sanitizeFields(['reply']),
  replyValidators,
  reviewController.replyToReview
);
router.patch('/:id/verify', verifyToken, requireActiveProvider('provider'), reviewController.verifyReview);
router.post('/:id/report', verifyToken, reportReviewValidators, reviewController.reportReview);

module.exports = router;
