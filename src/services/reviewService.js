const db = require('../models');

const { Review, Listing } = db;

// Note moyenne = moyenne de tous les avis (verifies ou publics), arrondie a 1
// decimale. isVerified reste affiche comme badge de confiance mais n'exclut
// plus un avis du calcul : un avis public sans reservation compte aussi.
// Appelée à chaque création ET à chaque suppression d'avis (modération admin).
async function recalculateListingRating(listingId) {
  const reviews = await Review.findAll({ where: { listingId } });
  const count = reviews.length;
  const avg = count > 0 ? reviews.reduce((sum, r) => sum + r.rating, 0) / count : 0;

  await Listing.update(
    { ratingAvg: Math.round(avg * 10) / 10, ratingCount: count },
    { where: { id: listingId } }
  );
}

module.exports = { recalculateListingRating };
