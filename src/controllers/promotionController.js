const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const db = require('../models');
const { getProviderPlan } = require('../services/planService');

const { Promotion, Listing } = db;

function activePromotionWhere() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    isActive: true,
    [Op.and]: [
      { [Op.or]: [{ startDate: null }, { startDate: { [Op.lte]: today } }] },
      { [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: today } }] },
    ],
  };
}

async function getOwnListing(req, res) {
  const listing = await Listing.findOne({ where: { userId: req.user.id } });
  if (!listing) {
    res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    return null;
  }
  return listing;
}

exports.getListingPromotions = async (req, res, next) => {
  try {
    const promotions = await Promotion.findAll({
      where: { listingId: req.params.id, ...activePromotionWhere() },
    });
    return res.json(promotions);
  } catch (err) {
    return next(err);
  }
};

exports.createPromotion = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const { limits } = await getProviderPlan(req.user.id);
    const activeCount = await Promotion.count({
      where: { listingId: listing.id, ...activePromotionWhere() },
    });
    if (activeCount >= limits.maxPromotions) {
      return res.status(400).json({
        message: `Votre plan (${limits.label}) autorise au maximum ${limits.maxPromotions} promotion(s) active(s). Passez à un plan supérieur pour en créer davantage.`,
      });
    }

    const { type, value, label, startDate, endDate } = req.body;
    const promotion = await Promotion.create({
      listingId: listing.id,
      type,
      value,
      label,
      startDate: startDate || null,
      endDate: endDate || null,
    });

    return res.status(201).json(promotion);
  } catch (err) {
    return next(err);
  }
};

exports.updatePromotion = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const promotion = await Promotion.findOne({
      where: { id: req.params.id, listingId: listing.id },
    });
    if (!promotion) {
      return res.status(404).json({ message: 'Promotion introuvable.' });
    }

    const { type, value, label, startDate, endDate, isActive } = req.body;
    if (type !== undefined) promotion.type = type;
    if (value !== undefined) promotion.value = value;
    if (label !== undefined) promotion.label = label;
    if (startDate !== undefined) promotion.startDate = startDate;
    if (endDate !== undefined) promotion.endDate = endDate;
    if (isActive !== undefined) promotion.isActive = isActive;
    await promotion.save();

    return res.json(promotion);
  } catch (err) {
    return next(err);
  }
};

exports.deletePromotion = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const promotion = await Promotion.findOne({
      where: { id: req.params.id, listingId: listing.id },
    });
    if (!promotion) {
      return res.status(404).json({ message: 'Promotion introuvable.' });
    }

    await promotion.destroy();
    return res.json({ message: 'Promotion supprimée.' });
  } catch (err) {
    return next(err);
  }
};
