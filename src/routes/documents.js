const express = require('express');
const documentController = require('../controllers/documentController');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

router.get('/:filename', verifyToken, documentController.getDocument);

module.exports = router;
