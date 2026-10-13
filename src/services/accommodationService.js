const db = require('../models');

const { Category } = db;

// "maisons-hotes" (pluriel) : slug reel en base, qui a diverge de
// "maison-hote" present dans seed.js (categorie probablement renommee depuis
// l'admin apres le seed initial) - verifie en direct (SELECT slug FROM
// categories WHERE parent_id = (lieux-de-mariage).id), ne pas resynchroniser
// avec seed.js sans revalider la base live.
const ACCOMMODATION_SLUG = 'maisons-hotes';

// "Maison d'hote" (sous-categorie de Lieux de mariage) : seul type de fiche
// avec un sejour en chambres (Arrivee/Depart + occupation) au lieu de la
// simple date d'evenement classique - voir leadController.createLead. Pas de
// sous-categories propres (contrairement a Transport) : verification directe
// sur la categorie de la fiche.
async function isAccommodationListing(listing) {
  const category = await Category.findByPk(listing.categoryId);
  return category?.slug === ACCOMMODATION_SLUG;
}

module.exports = { isAccommodationListing, ACCOMMODATION_SLUG };
