const express = require('express');
const cityController = require('../controllers/cityController');

const router = express.Router();

router.get('/', cityController.getCities);
router.get('/with-counts', cityController.getCitiesWithCounts);

module.exports = router;
