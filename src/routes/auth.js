const express = require('express');
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const { verifyToken } = require('../middleware/auth');
const { sanitizeFields } = require('../middleware/sanitize');

const sanitizeName = sanitizeFields(['firstName', 'lastName']);

const router = express.Router();

// Inscription publique reservee aux clients (CLAUDE.md) : les comptes
// prestataires sont exclusivement crees par l'admin (module M10), donc pas
// de champ role/categoryId/title ici.
const registerValidators = [
  body('firstName').trim().notEmpty().isLength({ max: 80 }).withMessage('Prénom requis.'),
  body('lastName').trim().notEmpty().isLength({ max: 80 }).withMessage('Nom requis.'),
  body('email').isEmail().withMessage('Email invalide.').normalizeEmail(),
  body('phone')
    .optional({ checkFalsy: true })
    .matches(/^\+?\d{8,15}$/)
    .withMessage('Téléphone invalide.'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Le mot de passe doit contenir au moins 8 caractères.'),
  body('weddingRole')
    .optional({ checkFalsy: true })
    .isIn(['bride', 'groom', 'other'])
    .withMessage('Rôle invalide.'),
];

const loginValidators = [
  body('email').isEmail().withMessage('Email invalide.').normalizeEmail(),
  body('password').notEmpty().withMessage('Mot de passe requis.'),
];

const forgotPasswordValidators = [
  body('email').isEmail().withMessage('Email invalide.').normalizeEmail(),
];

const resetPasswordValidators = [
  body('password')
    .isLength({ min: 8 })
    .withMessage('Le mot de passe doit contenir au moins 8 caractères.'),
];

const updateMeValidators = [
  body('firstName').optional().trim().notEmpty().isLength({ max: 80 }).withMessage('Prénom requis.'),
  body('lastName').optional().trim().notEmpty().isLength({ max: 80 }).withMessage('Nom requis.'),
  body('email').optional().isEmail().withMessage('Email invalide.').normalizeEmail(),
];

const changePasswordValidators = [
  body('currentPassword').notEmpty().withMessage('Mot de passe actuel requis.'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Le nouveau mot de passe doit contenir au moins 8 caractères.'),
];

router.post('/register', sanitizeName, registerValidators, authController.register);
router.get('/verify/:token', authController.verifyEmail);
router.post('/login', loginValidators, authController.login);
router.post('/refresh-token', authController.refreshToken);
router.get('/me', verifyToken, authController.me);
router.patch('/me', verifyToken, sanitizeName, updateMeValidators, authController.updateMe);
router.post('/forgot-password', forgotPasswordValidators, authController.forgotPassword);
router.post('/reset-password/:token', resetPasswordValidators, authController.resetPassword);
router.put(
  '/change-password',
  verifyToken,
  changePasswordValidators,
  authController.changePassword
);

module.exports = router;
