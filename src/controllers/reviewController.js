const path = require('path');
const { validationResult } = require('express-validator');
const db = require('../models');
const { persistBuffer, detectRealMimeType } = require('../middleware/upload');
const reviewService = require('../services/reviewService');

const { Review, ReviewPhoto, Booking, Listing, Dispute } = db;
const REVIEWS_DIR = path.join(__dirname, '../../uploads/reviews');
const VALID_DISPUTE_TYPES = ['no_show', 'misleading', 'fake_review', 'other'];

const SUB_RATING_FIELDS = [
  'qualityRating',
  'responseTimeRating',
  'professionalismRating',
  'valueRating',
  'flexibilityRating',
];

exports.createReview = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { bookingId, listingId: bodyListingId, comment, title, guestName } = req.body;
    const recommend = req.body.recommend === true || req.body.recommend === 'true';

    const subRatings = {};
    for (const field of SUB_RATING_FIELDS) {
      const value = Number(req.body[field]);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        return res.status(400).json({ message: 'Merci de noter les 5 critères (1 à 5 étoiles).' });
      }
      subRatings[field] = value;
    }
    const rating = Math.round(
      SUB_RATING_FIELDS.reduce((sum, field) => sum + subRatings[field], 0) / SUB_RATING_FIELDS.length
    );

    if (!title || title.trim().length < 10 || title.trim().length > 150) {
      return res.status(400).json({ message: 'Le titre doit contenir entre 10 et 150 caractères.' });
    }
    if (!comment || comment.trim().length < 75) {
      return res.status(400).json({ message: "L'avis doit contenir au moins 75 caractères." });
    }

    // Prestataires/admins ne peuvent pas publier d'avis (conflit d'interet).
    if (req.user && req.user.role !== 'client') {
      return res
        .status(403)
        .json({ message: 'Seuls les clients peuvent laisser un avis sur un prestataire.' });
    }

    let listingId;
    let finalBookingId = null;
    let isVerified = false;
    let finalGuestName = null;

    if (bookingId) {
      // Avis lie a une reservation reelle : verifie, comme avant.
      const booking = await Booking.findByPk(bookingId);
      if (!booking) {
        return res.status(404).json({ message: 'Réservation introuvable.' });
      }
      if (!req.user || booking.userId !== req.user.id) {
        return res.status(403).json({ message: 'Cette réservation ne vous appartient pas.' });
      }
      if (booking.status !== 'completed') {
        return res
          .status(403)
          .json({ message: "L'avis n'est possible qu'après une prestation terminée." });
      }

      const existingReview = await Review.findOne({ where: { bookingId } });
      if (existingReview) {
        return res.status(409).json({ message: 'Un avis a déjà été publié pour cette réservation.' });
      }

      listingId = booking.listingId;
      finalBookingId = bookingId;
      isVerified = true;
    } else {
      // Avis public sans reservation (visiteur anonyme ou client) : non verifie.
      if (!bodyListingId) {
        return res.status(400).json({ message: 'Prestataire requis.' });
      }
      const listing = await Listing.findByPk(bodyListingId);
      if (!listing) {
        return res.status(404).json({ message: 'Prestataire introuvable.' });
      }
      listingId = listing.id;

      if (!req.user) {
        if (!guestName || !guestName.trim()) {
          return res.status(400).json({ message: 'Votre nom est requis.' });
        }
        finalGuestName = guestName.trim().slice(0, 100);
      }
    }

    // Vérifie TOUTES les photos avant toute écriture en base, pour ne jamais
    // laisser un avis créé sans les photos que le client pensait joindre.
    const files = req.files || [];
    for (const file of files) {
      if (!detectRealMimeType(file.buffer)) {
        return res
          .status(400)
          .json({ message: 'Une des photos jointes est invalide. Utilisez JPG ou PNG.' });
      }
    }

    const review = await Review.create({
      bookingId: finalBookingId,
      listingId,
      userId: req.user ? req.user.id : null,
      guestName: finalGuestName,
      rating,
      title: title.trim(),
      recommend,
      ...subRatings,
      comment,
      isVerified,
    });

    for (const file of files) {
      const filename = persistBuffer(file.buffer, REVIEWS_DIR);
      await ReviewPhoto.create({ reviewId: review.id, url: `/uploads/reviews/${filename}` });
    }

    await reviewService.recalculateListingRating(listingId);

    const created = await Review.findByPk(review.id, {
      include: [{ model: ReviewPhoto, as: 'photos' }],
    });

    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
};

exports.replyToReview = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const review = await Review.findByPk(req.params.id, {
      include: [{ model: Listing, as: 'listing' }],
    });
    if (!review) {
      return res.status(404).json({ message: 'Avis introuvable.' });
    }
    if (review.listing.userId !== req.user.id) {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    const { reply } = req.body;
    if (!reply || !reply.trim()) {
      return res.status(400).json({ message: 'La réponse ne peut pas être vide.' });
    }

    review.providerReply = reply;
    await review.save();

    return res.json(review);
  } catch (err) {
    return next(err);
  }
};

// Un avis public sans reservation (isVerified=false a la creation) peut etre
// verifie manuellement par le prestataire une fois qu'il a confirme que le
// client existe reellement - complement au chemin automatique via booking
// (CLAUDE.md - "is_verified auto").
exports.verifyReview = async (req, res, next) => {
  try {
    const review = await Review.findByPk(req.params.id, {
      include: [{ model: Listing, as: 'listing' }],
    });
    if (!review) {
      return res.status(404).json({ message: 'Avis introuvable.' });
    }
    if (review.listing.userId !== req.user.id) {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    review.isVerified = true;
    await review.save();

    return res.json(review);
  } catch (err) {
    return next(err);
  }
};

exports.reportReview = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const review = await Review.findByPk(req.params.id);
    if (!review) {
      return res.status(404).json({ message: 'Avis introuvable.' });
    }

    const { type, description } = req.body;
    if (type && !VALID_DISPUTE_TYPES.includes(type)) {
      return res.status(400).json({ message: 'Type de signalement invalide.' });
    }

    const dispute = await Dispute.create({
      reporterId: req.user.id,
      reviewId: review.id,
      listingId: review.listingId,
      type: type || 'fake_review',
      description,
      status: 'open',
    });

    review.isReported = true;
    await review.save();

    return res.status(201).json(dispute);
  } catch (err) {
    return next(err);
  }
};
