// MariaDB stocke DataTypes.JSON en LONGTEXT (son type JSON n'est qu'un alias
// avec contrainte CHECK) : le driver ne le signale pas comme JSON, donc
// Sequelize ne parse pas automatiquement la valeur lue - elle revient sous
// forme de chaine brute. Getter defensif : parse si necessaire, sinon
// renvoie la valeur telle quelle (deja un objet/tableau, ou null).
function jsonColumnGetter(field) {
  return function get() {
    const raw = this.getDataValue(field);
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
}

module.exports = (sequelize, DataTypes) => {
  const Listing = sequelize.define(
    'Listing',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      categoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      title: { type: DataTypes.STRING(160), allowNull: false },
      // Slug URL (SEO) : /:categorySlug/:listingSlug au lieu de /listings/:id.
      // Genere depuis le titre a la creation (utils/slugify.js), unique.
      slug: { type: DataTypes.STRING(220), unique: true },
      description: { type: DataTypes.TEXT },
      priceFrom: { type: DataTypes.DECIMAL(10, 2) },
      priceTo: { type: DataTypes.DECIMAL(10, 2) },
      avgSpent: { type: DataTypes.DECIMAL(10, 2) },
      // Capacite affichee en fourchette (ex: "30 - 600 Invité(s)") comme
      // priceFrom/priceTo - capacityMin optionnel, capacity reste le maximum
      // (compatibilite avec les fiches existantes n'ayant qu'une seule valeur).
      capacityMin: { type: DataTypes.INTEGER },
      capacity: { type: DataTypes.INTEGER },
      city: { type: DataTypes.STRING(100) },
      address: { type: DataTypes.STRING(255) },
      latitude: { type: DataTypes.DECIMAL(10, 7) },
      longitude: { type: DataTypes.DECIMAL(10, 7) },
      // Lien Google Maps saisi par le prestataire (partage direct depuis
      // Google Maps) - affiche en fallback si latitude/longitude absents.
      googleMapsUrl: { type: DataTypes.STRING(500) },
      phone: { type: DataTypes.STRING(20) },
      website: { type: DataTypes.STRING(200) },
      facebookUrl: { type: DataTypes.STRING(200) },
      instagramUrl: { type: DataTypes.STRING(200) },
      tiktokUrl: { type: DataTypes.STRING(200) },
      linkedinUrl: { type: DataTypes.STRING(200) },
      whatsappUrl: { type: DataTypes.STRING(200) },
      logoUrl: { type: DataTypes.STRING(255) },
      // Types d'evenements : colonne inutilisee (bandeau desormais statique
      // et identique sur toutes les fiches, voir frontend/src/utils/eventTypes.js),
      // conservee au cas ou une selection par prestataire serait reintroduite.
      eventTypes: { type: DataTypes.JSON, get: jsonColumnGetter('eventTypes') },
      // Equipements du prestataire (icone + nom libres, choisis par lui) -
      // tableau de {icon, name}, voir frontend/src/utils/amenities.js pour
      // la palette d'icones proposee. Contrairement a eventTypes, variable
      // d'une fiche a l'autre (affiche uniquement si non vide).
      amenities: { type: DataTypes.JSON, get: jsonColumnGetter('amenities') },
      // Configuration SMTP/Resend propre au prestataire, pour que les emails
      // envoyes a SES clients (factures/contrats) partent de sa propre
      // adresse plutot que du SMTP central de la plateforme (repli par
      // defaut si non configure) - voir services/emailService.js. Forme :
      // { provider: 'smtp'|'resend', host, port, user, fromEmail,
      //   passEncrypted, apiKeyEncrypted }. passEncrypted/apiKeyEncrypted
      // sont chiffres via utils/secretCipher.js, jamais stockes en clair.
      emailSettings: { type: DataTypes.JSON, get: jsonColumnGetter('emailSettings') },
      // Matricule fiscal (registre du commerce), saisi facultativement par
      // l'admin a la creation (onboarding assiste, M10) - purement
      // declaratif, jamais verifie automatiquement.
      taxId: { type: DataTypes.STRING(40) },
      // Nom de fichier (PAS une URL publique) de la carte CIN du gerant,
      // document legal sensible - stocke hors de /uploads (voir
      // middleware/upload.js LEGAL_UPLOAD_DIR), jamais expose sur les
      // reponses publiques (voir listingController, attributs exclus).
      cinDocumentUrl: { type: DataTypes.STRING(255) },
      isVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      yearsExperience: { type: DataTypes.INTEGER },
      languages: { type: DataTypes.STRING(160) },
      ratingAvg: { type: DataTypes.DECIMAL(2, 1), allowNull: false, defaultValue: 0.0 },
      ratingCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      viewsCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      status: {
        type: DataTypes.ENUM('pending', 'active', 'suspended', 'rejected'),
        allowNull: false,
        defaultValue: 'pending',
      },
      rejectReason: { type: DataTypes.STRING(255) },
      // Acceptation des conditions de frais de mise en relation (M13) :
      // date + version des conditions acceptees. Sans acceptation, aucun
      // frais ne peut etre reclame (ni confirmation, ni facturation).
      connectionFeeTermsAcceptedAt: { type: DataTypes.DATE },
      connectionFeeTermsVersion: { type: DataTypes.STRING(20) },
    },
    {
      tableName: 'listings',
      // Soft delete natif Sequelize : destroy() renseigne deleted_at au lieu
      // de supprimer la ligne, et TOUTES les requetes (findAll/findOne/...)
      // excluent automatiquement les lignes soft-deleted, sans avoir a y
      // penser a chaque endroit (recherche publique, fiche detail...).
      // restore() remet deleted_at a null. paranoid:false explicite requis
      // pour consulter/atteindre une fiche supprimee (onglet admin "Supprimes").
      paranoid: true,
    }
  );

  Listing.associate = (models) => {
    Listing.belongsTo(models.User, { foreignKey: 'userId', as: 'owner' });
    Listing.belongsTo(models.Category, { foreignKey: 'categoryId', as: 'category' });
    // Sous-categories supplementaires (limitees par Plan.maxCategories).
    Listing.belongsToMany(models.Category, {
      through: models.ListingCategory,
      foreignKey: 'listingId',
      otherKey: 'categoryId',
      as: 'extraCategories',
    });
    Listing.hasMany(models.Image, { foreignKey: 'listingId', as: 'images' });
    Listing.hasMany(models.Video, { foreignKey: 'listingId', as: 'videos' });
    Listing.hasMany(models.Package, { foreignKey: 'listingId', as: 'packages' });
    Listing.hasMany(models.Availability, { foreignKey: 'listingId', as: 'availability' });
    Listing.hasMany(models.Promotion, { foreignKey: 'listingId', as: 'promotions' });
    Listing.hasMany(models.Lead, { foreignKey: 'listingId', as: 'leads' });
    Listing.hasMany(models.Client, { foreignKey: 'listingId', as: 'clients' });
    Listing.hasMany(models.Booking, { foreignKey: 'listingId', as: 'bookings' });
    Listing.hasMany(models.Review, { foreignKey: 'listingId', as: 'reviews' });
    Listing.hasMany(models.Contract, { foreignKey: 'listingId', as: 'contracts' });
    Listing.hasMany(models.Invoice, { foreignKey: 'listingId', as: 'invoices' });
    Listing.hasMany(models.Favorite, { foreignKey: 'listingId', as: 'favoritedBy' });
    // Flotte de vehicules : uniquement pertinent pour les prestataires de la
    // categorie Transport (verifie a l'ecriture, jamais en base - toute
    // fiche PEUT avoir des vehicules, la contrainte est applicative).
    Listing.hasMany(models.Vehicle, { foreignKey: 'listingId', as: 'vehicles' });
    Listing.hasMany(models.VehicleBooking, { foreignKey: 'listingId', as: 'vehicleBookings' });
    // "Mes evenements" (M5) : evenements organises PAR le prestataire
    // (journee portes ouvertes, show cooking...) - a ne pas confondre avec
    // les "types d'evenements" du client (mariage...), purement editoriaux
    // (voir MODULES.md M3). Ouvert a tous les plans, aucune restriction.
    Listing.hasMany(models.ProviderEvent, { foreignKey: 'listingId', as: 'providerEvents' });
    Listing.hasMany(models.Commission, { foreignKey: 'listingId', as: 'commissions' });
    Listing.hasMany(models.Dispute, {
      foreignKey: 'listingId',
      as: 'disputes',
      onDelete: 'SET NULL',
    });
  };

  return Listing;
};
