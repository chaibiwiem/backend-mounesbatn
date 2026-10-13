const express = require('express');
const imageController = require('../controllers/imageController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');

const router = express.Router();

router.patch('/:id/primary', verifyToken, requireActiveProvider('provider'), imageController.setPrimaryImage);
router.delete('/:id', verifyToken, requireActiveProvider('provider'), imageController.deleteImage);

module.exports = router;
