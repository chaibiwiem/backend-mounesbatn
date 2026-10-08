// Convertit un titre en slug URL (minuscule, sans accents, tirets) - utilise
// pour les URLs publiques /:categorySlug/:listingSlug (SEO), au lieu de
// l'id numerique brut.
function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

// Garantit l'unicite du slug (colonne unique) : ajoute -2, -3... en cas de
// collision avec une fiche existante (ex. deux prestataires "Traiteur Sonia").
async function generateUniqueListingSlug(Listing, title, excludeId = null) {
  const base = slugify(title) || 'prestataire';
  let candidate = base;
  let suffix = 2;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const where = { slug: candidate };
    const existing = await Listing.findOne({ where, paranoid: false });
    if (!existing || (excludeId && Number(existing.id) === Number(excludeId))) {
      return candidate;
    }
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}

module.exports = { slugify, generateUniqueListingSlug };
