const { validationResult } = require('express-validator');
const db = require('../models');

const { Favorite, Listing, Category, Image } = db;

exports.getMyFavorites = async (req, res, next) => {
  try {
    const favorites = await Favorite.findAll({
      where: { userId: req.user.id },
      include: [
        {
          model: Listing,
          as: 'listing',
          include: [
            { model: Category, as: 'category', attributes: ['id', 'name', 'slug'] },
            {
              model: Image,
              as: 'images',
              attributes: ['id', 'url', 'isPrimary'],
              required: false,
              separate: true,
              where: { isPrimary: true },
              limit: 1,
            },
          ],
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    const listings = favorites.filter((f) => f.listing).map((f) => f.listing);
    return res.json(listings);
  } catch (err) {
    return next(err);
  }
};

exports.addFavorite = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { listingId } = req.body;

    const listing = await Listing.findOne({ where: { id: listingId, status: 'active' } });
    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }

    const [favorite] = await Favorite.findOrCreate({
      where: { userId: req.user.id, listingId },
      defaults: { userId: req.user.id, listingId },
    });

    return res.status(201).json(favorite);
  } catch (err) {
    return next(err);
  }
};

exports.removeFavorite = async (req, res, next) => {
  try {
    const { listingId } = req.params;
    await Favorite.destroy({ where: { userId: req.user.id, listingId } });
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};
