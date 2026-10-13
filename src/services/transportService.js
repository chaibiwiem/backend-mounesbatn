const db = require('../models');

const { Category } = db;

// Un prestataire s'inscrit toujours sous une sous-categorie precise (jamais
// la categorie principale elle-meme, CLAUDE.md) : "categorie Transport"
// signifie donc soit la categorie Transport elle-meme, soit l'une de ses
// sous-categories (Location de voitures/de bus). Verifie via la categorie de
// la fiche plutot qu'une contrainte SQL, pour rester correct si de nouvelles
// sous-categories Transport sont ajoutees plus tard.
// Utilise par vehicleController (gestion de flotte) et leadController (champs
// specifiques a une demande de location de vehicule).
async function isTransportListing(listing) {
  const category = await Category.findByPk(listing.categoryId);
  if (!category) return false;
  if (category.slug === 'transport') return true;
  if (category.parentId) {
    const parent = await Category.findByPk(category.parentId);
    return parent?.slug === 'transport';
  }
  return false;
}

module.exports = { isTransportListing };
