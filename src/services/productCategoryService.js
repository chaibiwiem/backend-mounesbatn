const db = require('../models');

const { Category } = db;

const PRODUCT_CATEGORY_SLUG = 'parfums-soins';

// Prestataires de la categorie "Parfums & Soins" : vendent des PRODUITS
// commandes en volume (coffrets invites, musc, bakhour, soins), pas une
// prestation datee - le formulaire de demande de devis leur propose donc
// quantite/date de livraison au lieu de date d'evenement/nombre d'invites
// (voir leadController.createLead). Meme logique que isTransportListing
// (transportService.js) : verifie via la categorie de la fiche, categorie
// principale ou l'une de ses sous-categories.
async function isProductCategoryListing(listing) {
  const category = await Category.findByPk(listing.categoryId);
  if (!category) return false;
  if (category.slug === PRODUCT_CATEGORY_SLUG) return true;
  if (category.parentId) {
    const parent = await Category.findByPk(category.parentId);
    return parent?.slug === PRODUCT_CATEGORY_SLUG;
  }
  return false;
}

module.exports = { isProductCategoryListing, PRODUCT_CATEGORY_SLUG };
