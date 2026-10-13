const express = require('express');
const { body } = require('express-validator');
const providerEventController = require('../controllers/providerEventController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const router = express.Router();

const PROVIDER_EVENT_TYPES = [
  'portes_ouvertes',
  'show_cooking',
  'defile',
  'lancement',
  'degustation',
  'autre',
];

const updateEventValidators = [
  body('title').optional({ checkFalsy: true }).trim().isLength({ max: 160 }),
  body('type').optional({ checkFalsy: true }).isIn(PROVIDER_EVENT_TYPES).withMessage('Type invalide.'),
  body('description').optional({ checkFalsy: true }).isLength({ max: 2000 }),
  body('eventDate').optional({ checkFalsy: true }).isISO8601().withMessage('Date invalide.'),
  body('startTime').optional({ checkFalsy: true }).matches(/^\d{2}:\d{2}(:\d{2})?$/).withMessage('Heure de début invalide.'),
  body('endTime')
    .optional({ checkFalsy: true })
    .matches(/^\d{2}:\d{2}(:\d{2})?$/)
    .withMessage('Heure de fin invalide.')
    .custom((value, { req }) => {
      if (req.body.startTime && value <= req.body.startTime) {
        throw new Error('L’heure de fin doit être postérieure à l’heure de début.');
      }
      return true;
    }),
  body('location').optional({ checkFalsy: true }).trim().isLength({ max: 255 }),
  body('isPublished').optional().isBoolean().toBoolean(),
];

router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  upload.single('image'),
  updateEventValidators,
  providerEventController.updateEvent
);
router.patch(
  '/:id/publish',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  body('isPublished').optional().isBoolean().toBoolean(),
  providerEventController.publishEvent
);
router.delete('/:id', verifyToken, requireActiveProvider('provider', 'admin'), providerEventController.deleteEvent);

module.exports = router;
