const express = require('express');
const { body } = require('express-validator');
const leadController = require('../controllers/leadController');
const commissionController = require('../controllers/commissionController');
const { optionalAuth, verifyToken, requireActiveProvider, requireRole } = require('../middleware/auth');
const { sanitizeFields } = require('../middleware/sanitize');

const sanitizeMessage = sanitizeFields(['message']);

const router = express.Router();

const createLeadValidators = [
  body('listingId').notEmpty().withMessage('Prestataire requis.').toInt(),
  body('firstName').trim().notEmpty().isLength({ max: 80 }).withMessage('Prénom requis.'),
  body('lastName').trim().notEmpty().isLength({ max: 80 }).withMessage('Nom requis.'),
  body('email').isEmail().withMessage('Email invalide.').normalizeEmail(),
  body('phone')
    .trim()
    .notEmpty()
    .matches(/^\+?\d{8,15}$/)
    .withMessage('Téléphone invalide.'),
  body('eventDate').optional({ checkFalsy: true }).isISO8601().withMessage('Date invalide.'),
  body('dateFlexible').optional().isBoolean().toBoolean(),
  body('guests').optional({ checkFalsy: true }).isLength({ max: 40 }),
  body('message').optional({ checkFalsy: true }).isLength({ max: 2000 }),
  // Champs location de vehicule (prestataires Transport uniquement, cf.
  // leadController - ignores pour les autres categories meme si envoyes).
  body('departureDatetime')
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage('Date de départ invalide.'),
  body('returnDatetime')
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage('Date de retour invalide.')
    .custom((value, { req }) => {
      if (req.body.departureDatetime && new Date(value) <= new Date(req.body.departureDatetime)) {
        throw new Error('La date de retour doit être postérieure à la date de départ.');
      }
      return true;
    }),
  // Pas de checkFalsy ici : 0 est une valeur falsy mais invalide (< 1), elle
  // doit etre rejetee, pas traitee comme "absente" - seule la chaine vide
  // (champ transport envoye tel quel par ContactForm meme hors categorie
  // Transport, cf. initialState) doit etre ignoree comme "absente".
  body('passengers')
    .if((value) => value !== undefined && value !== '')
    .isInt({ min: 1 })
    .withMessage('Nombre de passagers invalide.')
    .toInt(),
  body('vehicleId').optional({ checkFalsy: true }).isInt().withMessage('Véhicule invalide.').toInt(),
  body('withDriver').optional({ checkFalsy: true }).isBoolean().toBoolean(),
  body('decorationId').optional({ checkFalsy: true }).isInt().withMessage('Modèle de décoration invalide.').toInt(),
  body('pickupLocation').optional({ checkFalsy: true }).trim().isLength({ max: 255 }),
  body('options').optional().isArray().withMessage('Options invalides.'),
  body('options.*.vehicleOptionId').isInt().withMessage('Option invalide.').toInt(),
  body('options.*.quantity').optional().isInt({ min: 1, max: 10 }).withMessage('Quantité invalide.').toInt(),
  // Demande d'interet sur un evenement prestataire (M5, "Je suis interesse(e)")
  // - independant de la categorie Transport.
  body('providerEventId').optional({ checkFalsy: true }).isInt().withMessage('Événement invalide.').toInt(),
  // Champs commande produit (prestataires "Parfums & Soins" uniquement, cf.
  // leadController - ignores pour les autres categories meme si envoyes).
  body('packageId').optional({ checkFalsy: true }).isInt().withMessage('Produit invalide.').toInt(),
  // Meme raison que `passengers` plus haut : ContactForm envoie ce champ en
  // chaine vide pour toute categorie hors "Parfums & Soins" (spread complet
  // du form standard) - il faut l'ignorer comme absent, mais rejeter 0 (falsy
  // mais invalide) s'il est explicitement envoye.
  body('quantity')
    .if((value) => value !== undefined && value !== '')
    .isInt({ min: 1 })
    .withMessage('Quantité invalide.')
    .toInt(),
  body('deliveryDate')
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage('Date de livraison invalide.')
    .custom((value) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (new Date(value) < today) {
        throw new Error('La date de livraison ne peut pas être dans le passé.');
      }
      return true;
    }),
  body('deliveryAddress').optional({ checkFalsy: true }).trim().isLength({ max: 255 }),
  body('deliveryMode')
    .optional({ checkFalsy: true })
    .isIn(['retrait', 'livraison'])
    .withMessage('Mode de livraison invalide.')
    .custom((value, { req }) => {
      if (value === 'livraison' && !req.body.deliveryAddress) {
        throw new Error('Adresse de livraison requise.');
      }
      return true;
    }),
  body('customization').optional({ checkFalsy: true }).isLength({ max: 1000 }),
  // Champs sejour (prestataires "Maison d'hote" uniquement, cf.
  // leadController - ignores pour les autres categories meme si envoyes).
  body('checkInDate').optional({ checkFalsy: true }).isISO8601().withMessage('Date d’arrivée invalide.'),
  body('checkOutDate')
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage('Date de départ invalide.')
    .custom((value, { req }) => {
      if (req.body.checkInDate && new Date(value) <= new Date(req.body.checkInDate)) {
        throw new Error('La date de départ doit être postérieure à la date d’arrivée.');
      }
      return true;
    }),
  body('rooms').optional().isArray({ min: 1 }).withMessage('Au moins une chambre requise.'),
  body('rooms.*.adults').isInt({ min: 1 }).withMessage('Nombre d’adultes invalide.').toInt(),
  body('rooms.*.children').optional().isInt({ min: 0 }).withMessage('Nombre d’enfants invalide.').toInt(),
  body('rooms.*.babies').optional().isInt({ min: 0 }).withMessage('Nombre de lits bébé invalide.').toInt(),
];

router.post('/', optionalAuth, sanitizeMessage, createLeadValidators, leadController.createLead);
router.get('/me', verifyToken, leadController.getMyLeads);
router.patch(
  '/:id/status',
  verifyToken,
  requireActiveProvider('provider', 'admin'),
  body('status').notEmpty(),
  leadController.updateLeadStatus
);

// Frais de mise en relation (M13) : 1re confirmation par le prestataire
// proprietaire (verifie dans le controleur). Montant calcule cote serveur
// (forfait de la categorie) - jamais envoye par le client. Reste possible
// abonnement expire : il s'agit de frais deja engages, pas de contenu.
router.post(
  '/:id/confirm',
  verifyToken,
  requireRole('provider'),
  [
    body('eventDate').isISO8601().withMessage("Date de l'événement invalide."),
    body('declaredAmount')
      .optional({ checkFalsy: true })
      .isFloat({ min: 0 })
      .withMessage('Montant du contrat invalide.')
      .toFloat(),
    body('fromMounesba')
      .custom((value) => value === true || value === 'true')
      .withMessage('Confirmez que ce client vous a contacté via Mounesba.'),
  ],
  commissionController.confirmLead
);

module.exports = router;
