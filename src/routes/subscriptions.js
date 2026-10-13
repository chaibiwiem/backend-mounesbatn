const express = require('express');
const subscriptionController = require('../controllers/subscriptionController');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken, requireRole('provider'));

// Lecture seule : le changement de plan est gere par l'admin uniquement
// (PATCH /api/admin/providers/:id/subscription), pas de self-service ici —
// coherent avec "aucun paiement en ligne, activation geree par l'admin"
// (CLAUDE.md).
router.get('/me', subscriptionController.getMySubscription);

module.exports = router;
