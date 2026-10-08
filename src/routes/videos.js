const express = require('express');
const { body } = require('express-validator');
const videoController = require('../controllers/videoController');
const { verifyToken, requireActiveProvider } = require('../middleware/auth');
const { uploadThumbnailOnly } = require('../middleware/upload');

const router = express.Router();

const updateVideoValidators = [body('title').optional({ checkFalsy: true }).isLength({ max: 160 })];

router.patch(
  '/:id',
  verifyToken,
  requireActiveProvider('provider'),
  uploadThumbnailOnly.fields([{ name: 'thumbnail', maxCount: 1 }]),
  updateVideoValidators,
  videoController.updateVideo
);
router.delete('/:id', verifyToken, requireActiveProvider('provider'), videoController.deleteVideo);

module.exports = router;
