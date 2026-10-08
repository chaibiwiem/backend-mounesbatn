const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const db = require('../models');
const { deleteStoredFile } = require('../services/storageService');
const { encrypt } = require('../utils/secretCipher');
const emailService = require('../services/emailService');
const { PLAN_CATALOG, getProviderPlan, isSubscriptionExpired } = require('../services/planService');
const connectionFeeService = require('../services/connectionFeeService');

// Frais de mise en relation (M13) : conditions commerciales Mounesba ->
// prestataire, jamais exposees sur les reponses publiques.
const CATEGORY_FEE_ATTRIBUTES = ['commissionEnabled', 'commissionType', 'commissionValue'];

// Plans "mis en avant" (Parametres admin > Plans & Tarifs, champ `featured`) -
// recalcule a chaque appel (peu couteux, 3-4 entrees) plutot qu'une liste
// figee, pour refleter immediatement un changement admin (ex. Elite marque
// featured) sans redemarrage serveur - meme principe que PLAN_CATALOG.
function getFeaturedPlanKeys() {
  return Object.keys(PLAN_CATALOG).filter((key) => PLAN_CATALOG[key].featured);
}

// Un abonnement "active" dont la date de fin est depassee ne doit plus
// beneficier du boost de recherche (meme regle que planService.getProviderPlan,
// qui elle retombe sur Starter pour l'ensemble des limites de fonctionnalites).
function today() {
  return new Date().toISOString().slice(0, 10);
}

const {
  Listing,
  Category,
  Image,
  Video,
  Package,
  Promotion,
  Review,
  User,
  ReviewPhoto,
  Subscription,
  Favorite,
  Vehicle,
  Lead,
  AssociatedService,
  ListingCategory,
} = db;

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

// Resout une liste de slugs (categorie principale et/ou sous-categorie) en
// ids de categories a filtrer - factorise hors de searchListings pour etre
// reutilise par searchListingsByCategories (meme regle : une categorie
// principale n'a jamais de fiche directement rattachee, on inclut donc aussi
// ses sous-categories).
async function resolveCategoryIdsForSlugs(slugs) {
  const categoryRecords = await Category.findAll({ where: { slug: slugs } });
  if (categoryRecords.length === 0) return -1;

  const topLevel = categoryRecords.filter((c) => c.parentId === null);
  const subCategories = categoryRecords.filter((c) => c.parentId !== null);
  let categoryIds = subCategories.map((c) => c.id);
  if (topLevel.length > 0) {
    const children = await Category.findAll({
      where: { parentId: topLevel.map((c) => c.id) },
      attributes: ['id'],
    });
    categoryIds = [...categoryIds, ...topLevel.map((c) => c.id), ...children.map((c) => c.id)];
  }
  return [...new Set(categoryIds)];
}

// Fiches rattachees a l'une de ces categories via une sous-categorie
// SUPPLEMENTAIRE (ListingCategory) encore autorisee par leur plan : les
// premieres (par ordre d'ajout) dans la limite maxCategories - 1, selon le
// plan reellement applique (Starter si expire, cf. planService). Ainsi un
// prestataire retrograde ou expire n'apparait plus dans ses categories en
// surplus, sans qu'on supprime ses choix (retablis s'il renouvelle).
async function listingIdsViaExtraCategories(categoryIds) {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) return [];
  const matches = await ListingCategory.findAll({
    where: { categoryId: categoryIds },
    attributes: ['listingId'],
  });
  const candidateIds = [...new Set(matches.map((m) => Number(m.listingId)))];
  if (candidateIds.length === 0) return [];

  const [listings, allExtras] = await Promise.all([
    Listing.findAll({ where: { id: candidateIds }, attributes: ['id', 'userId'] }),
    ListingCategory.findAll({ where: { listingId: candidateIds }, order: [['id', 'ASC']] }),
  ]);
  const subscriptions = await Subscription.findAll({
    where: { userId: listings.map((l) => l.userId) },
  });
  const subscriptionByUser = new Map(subscriptions.map((s) => [Number(s.userId), s]));
  const wanted = new Set(categoryIds.map(Number));

  return listings
    .filter((listing) => {
      const subscription = subscriptionByUser.get(Number(listing.userId));
      const planKey = subscription && !isSubscriptionExpired(subscription) ? subscription.plan : 'starter';
      const allowedExtras = (PLAN_CATALOG[planKey]?.maxCategories ?? 1) - 1;
      return allExtras
        .filter((extra) => Number(extra.listingId) === Number(listing.id))
        .slice(0, Math.max(0, allowedExtras))
        .some((extra) => wanted.has(Number(extra.categoryId)));
    })
    .map((listing) => listing.id);
}

// Condition "fiche dans ces categories" : sous-categorie d'inscription OU
// sous-categorie supplementaire autorisee (voir ci-dessus).
async function categoryFilterClause(categoryIds) {
  if (!Array.isArray(categoryIds)) return { categoryId: categoryIds };
  const extraListingIds = await listingIdsViaExtraCategories(categoryIds);
  if (extraListingIds.length === 0) return { categoryId: categoryIds };
  return { [Op.or]: [{ categoryId: categoryIds }, { id: extraListingIds }] };
}

exports.searchListings = async (req, res, next) => {
  try {
    const {
      q,
      category,
      city,
      priceMin,
      priceMax,
      minRating,
      promo,
      minSeats,
      vehicleType,
      sort = 'relevance',
      page = 1,
      limit = 12,
    } = req.query;

    const where = { status: 'active' };

    if (q) {
      where[Op.or] = [
        { title: { [Op.like]: `%${q}%` } },
        { description: { [Op.like]: `%${q}%` } },
      ];
    }

    if (city) where.city = city;

    if (priceMin || priceMax) {
      where.priceFrom = {};
      if (priceMin) where.priceFrom[Op.gte] = Number(priceMin);
      if (priceMax) where.priceFrom[Op.lte] = Number(priceMax);
    }

    if (minRating) where.ratingAvg = { [Op.gte]: Number(minRating) };

    if (category) {
      // Accepte un slug unique ou plusieurs (checkboxes du panneau de
      // filtres : ?category=a&category=b), pour permettre de cocher
      // plusieurs sous-categories d'une meme famille a la fois.
      const slugs = Array.isArray(category) ? category : [category];
      // Op.and plutot que where.categoryId : la recherche texte (q) occupe
      // deja where[Op.or] au meme niveau.
      const categoryClause = await categoryFilterClause(await resolveCategoryIdsForSlugs(slugs));
      where[Op.and] = [...(where[Op.and] || []), categoryClause];
    }

    const include = [
      { model: Category, as: 'category', attributes: ['id', 'name', 'slug'] },
      {
        model: Image,
        as: 'images',
        attributes: ['id', 'url', 'isPrimary'],
        required: false,
        separate: true,
        order: [['isPrimary', 'DESC'], ['sortOrder', 'ASC']],
        limit: 5,
      },
      {
        model: Promotion,
        as: 'promotions',
        attributes: ['id', 'type', 'value', 'label'],
        required: promo === 'true',
        where: activePromotionWhere(),
      },
      // Uniquement pour savoir si la fiche a au moins une video (bouton
      // lecture sur la carte de recherche) - pas besoin des donnees completes.
      {
        model: Video,
        as: 'videos',
        attributes: ['id'],
        required: false,
        separate: true,
        limit: 1,
      },
    ];

    // Filtres flotte (categorie Transport uniquement) : places minimum et/ou
    // type de vehicule. `required: true` restreint naturellement aux fiches
    // ayant au moins un vehicule actif correspondant, sans avoir a filtrer
    // explicitement par categorie (une fiche hors Transport n'a jamais de
    // vehicule, donc ne matcherait de toute facon jamais ce join).
    if (minSeats || vehicleType) {
      const vehicleWhere = { isAvailable: true };
      if (minSeats) vehicleWhere.seats = { [Op.gte]: Number(minSeats) };
      if (vehicleType) vehicleWhere.type = vehicleType;

      include.push({
        model: Vehicle,
        as: 'vehicles',
        attributes: [],
        required: true,
        where: vehicleWhere,
      });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 50);
    const offset = (pageNum - 1) * limitNum;

    let rows;
    let count;

    if (sort === 'price_asc' || sort === 'price_desc' || sort === 'rating' || sort === 'popularity') {
      const order = {
        price_asc: [['priceFrom', 'ASC']],
        price_desc: [['priceFrom', 'DESC']],
        rating: [['ratingAvg', 'DESC']],
        popularity: [['viewsCount', 'DESC']],
      }[sort];

      ({ rows, count } = await Listing.findAndCountAll({
        where,
        include,
        order,
        limit: limitNum,
        offset,
        distinct: true,
        // Documents legaux sensibles (CLAUDE.md, section Securite) : jamais
        // exposes sur une reponse publique.
        attributes: { exclude: ['taxId', 'cinDocumentUrl'] },
      }));
    } else {
      // Tri par defaut : mise en avant Premium (MODULES.md M9). La pagination
      // combinee a l'include hasMany `promotions` force Sequelize a envelopper
      // la requete dans une sous-requete ; un CASE brut injecte dans `order`
      // y est reevalue tel quel dans la partie externe, ou la table derivee
      // n'expose plus les colonnes d'origine mais leurs alias camelCase, ce
      // qui casse la requete ("Unknown column") des qu'un abonne Premium
      // existe. On evite ce piege en triant/paginant cote JS : le volume de
      // fiches actives reste modeste pour cette plateforme.
      const premiumProviders = await Subscription.findAll({
        where: {
          plan: getFeaturedPlanKeys(),
          status: 'active',
          [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: today() } }],
        },
        attributes: ['userId'],
      });
      const premiumUserIds = new Set(premiumProviders.map((p) => Number(p.userId)));

      const allRows = await Listing.findAll({
        where,
        include,
        order: [['ratingAvg', 'DESC'], ['viewsCount', 'DESC']],
        attributes: { exclude: ['taxId', 'cinDocumentUrl'] },
      });

      // Classement (M13) : dans chaque groupe (mis en avant / autres), score =
      // note moyenne + bonus des evenements realises via Mounesba (double
      // confirmation), plafonne - voir connectionFeeService.rankingScore. Tri
      // stable : a score egal, l'ordre note puis vues ci-dessus est conserve.
      const realizedCounts = await connectionFeeService.countRealizedByListing(allRows.map((row) => row.id));
      const score = (row) => connectionFeeService.rankingScore(row.ratingAvg, realizedCounts.get(Number(row.id)));
      const byScore = (a, b) => score(b) - score(a);

      const premiumRows = [];
      const otherRows = [];
      for (const row of allRows) {
        (premiumUserIds.has(Number(row.userId)) ? premiumRows : otherRows).push(row);
      }
      const sorted = [...premiumRows.sort(byScore), ...otherRows.sort(byScore)];

      count = sorted.length;
      rows = sorted.slice(offset, offset + limitNum);
    }

    let favoritedIds = new Set();
    if (req.user?.role === 'client') {
      const favorites = await Favorite.findAll({
        where: { userId: req.user.id, listingId: rows.map((r) => r.id) },
        attributes: ['listingId'],
      });
      favoritedIds = new Set(favorites.map((f) => Number(f.listingId)));
    }

    const results = rows.map((row) => {
      const json = row.toJSON();
      const hasVideo = (json.videos?.length || 0) > 0;
      delete json.videos;
      return { ...json, hasVideo, isFavorited: favoritedIds.has(row.id) };
    });

    return res.json({
      results,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil(count / limitNum) || 1,
      },
    });
  } catch (err) {
    return next(err);
  }
};

// Prestataires "en avant" (tri par defaut, premium en tete) pour une seule
// categorie, sans les filtres avances (prix/ville/promo...) - coeur partage
// par searchListingsByCategories ci-dessous, une requete DB par categorie.
async function getFeaturedListingsForCategory(categorySlug, limit) {
  const categoryIds = await resolveCategoryIdsForSlugs([categorySlug]);

  const include = [
    { model: Category, as: 'category', attributes: ['id', 'name', 'slug'] },
    {
      model: Image,
      as: 'images',
      attributes: ['id', 'url', 'isPrimary'],
      required: false,
      separate: true,
      order: [['isPrimary', 'DESC'], ['sortOrder', 'ASC']],
      limit: 5,
    },
    { model: Promotion, as: 'promotions', attributes: ['id', 'type', 'value', 'label'], required: false, where: activePromotionWhere() },
  ];

  const premiumProviders = await Subscription.findAll({
    where: {
      plan: getFeaturedPlanKeys(),
      status: 'active',
      [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: today() } }],
    },
    attributes: ['userId'],
  });
  const premiumUserIds = new Set(premiumProviders.map((p) => Number(p.userId)));

  const allRows = await Listing.findAll({
    where: { status: 'active', ...(await categoryFilterClause(categoryIds)) },
    include,
    order: [['ratingAvg', 'DESC'], ['viewsCount', 'DESC']],
    attributes: { exclude: ['taxId', 'cinDocumentUrl'] },
  });

  const premiumRows = [];
  const otherRows = [];
  for (const row of allRows) {
    (premiumUserIds.has(Number(row.userId)) ? premiumRows : otherRows).push(row);
  }

  return [...premiumRows, ...otherRows].slice(0, limit).map((row) => row.toJSON());
}

// Regroupe en une seule requete HTTP ce qui necessitait auparavant un appel
// searchListings par categorie affichee (PrestatairesLanding : jusqu'a ~18
// appels paralleles au chargement de la page, cf. limite de connexions du
// navigateur et risque d'epuiser le rate limiter sous trafic concurrent).
// ?categories=slug1,slug2,...&limit=8 -> { [slug]: Listing[] }.
exports.searchListingsByCategories = async (req, res, next) => {
  try {
    const { categories, limit = 8 } = req.query;
    if (!categories) {
      return res.status(400).json({ message: 'Le paramètre categories est requis.' });
    }
    const slugs = String(categories)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 24);

    const entries = await Promise.all(
      slugs.map(async (slug) => [slug, await getFeaturedListingsForCategory(slug, limitNum)])
    );
    const byCategory = Object.fromEntries(entries);

    if (req.user?.role === 'client') {
      const allIds = Object.values(byCategory).flatMap((rows) => rows.map((r) => r.id));
      const favorites = await Favorite.findAll({
        where: { userId: req.user.id, listingId: allIds },
        attributes: ['listingId'],
      });
      const favoritedIds = new Set(favorites.map((f) => Number(f.listingId)));
      for (const rows of Object.values(byCategory)) {
        rows.forEach((r) => {
          r.isFavorited = favoritedIds.has(r.id);
        });
      }
    }

    return res.json(byCategory);
  } catch (err) {
    return next(err);
  }
};

// Partagee par la recherche par id (legacy /:id) et par slug (URL publique
// SEO /:categorySlug/:listingSlug) : meme reponse, seule la clause `where`
// de resolution de la fiche change.
async function respondWithListingDetail(where, req, res, next) {
  try {
    const listing = await Listing.findOne({
      where: { ...where, status: 'active' },
      include: [
        {
          model: Category,
          as: 'category',
          attributes: { exclude: CATEGORY_FEE_ATTRIBUTES },
          include: [
            { model: AssociatedService, as: 'associatedServices' },
            // Le listing est toujours rattache a une sous-categorie
            // (CLAUDE.md), les services associes vivent sur la categorie
            // principale (parent) - voir AssociatedService.
            {
              model: Category,
              as: 'parent',
              attributes: { exclude: CATEGORY_FEE_ATTRIBUTES },
              include: [{ model: AssociatedService, as: 'associatedServices' }],
            },
          ],
        },
        { model: User, as: 'owner', attributes: ['id', 'firstName', 'lastName'] },
        { model: Image, as: 'images' },
        { model: Video, as: 'videos' },
        { model: Package, as: 'packages' },
        {
          model: Promotion,
          as: 'promotions',
          required: false,
          where: activePromotionWhere(),
        },
        {
          model: Review,
          as: 'reviews',
          required: false,
          where: { isReported: false },
          include: [
            { model: User, as: 'author', attributes: ['id', 'firstName'], required: false },
            { model: ReviewPhoto, as: 'photos' },
          ],
        },
      ],
      order: [[{ model: Image, as: 'images' }, 'sortOrder', 'ASC']],
      attributes: { exclude: ['taxId', 'cinDocumentUrl'] },
    });

    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }

    await listing.increment('viewsCount');

    const ratingBreakdown = [5, 4, 3, 2, 1].map((star) => ({
      star,
      count: listing.reviews.filter((r) => r.rating === star).length,
    }));

    let isFavorited = false;
    if (req.user?.role === 'client') {
      const favorite = await Favorite.findOne({ where: { userId: req.user.id, listingId: listing.id } });
      isFavorited = Boolean(favorite);
    }

    // Badge "Réponse en 24h" (carte coordonnées, M4/CLAUDE.md) : meme calcul
    // que leadController.getListingLeads (taux de reponse sous 24h < 50% ->
    // badge retire), mais public - pas de details individuels des leads ici.
    const providerLeads = await Lead.findAll({
      where: { listingId: listing.id },
      attributes: ['createdAt', 'answeredAt'],
    });
    const totalLeads = providerLeads.length;
    const answeredWithin24h = providerLeads.filter((lead) => {
      if (!lead.answeredAt) return false;
      return lead.answeredAt.getTime() - lead.createdAt.getTime() <= 24 * 60 * 60 * 1000;
    }).length;
    const responseRate = totalLeads > 0 ? Math.round((answeredWithin24h / totalLeads) * 100) : null;
    const fastResponseBadge = responseRate === null ? true : responseRate >= 50;

    // Compteur public (M13) : evenements realises via Mounesba, apres double
    // confirmation (prestataire + admin) - lignes validated/invoiced/paid.
    const realizedEventsCount = await connectionFeeService.countRealizedEvents(listing.id);

    return res.json({ ...listing.toJSON(), ratingBreakdown, isFavorited, fastResponseBadge, realizedEventsCount });
  } catch (err) {
    return next(err);
  }
}

exports.getListingDetail = (req, res, next) =>
  respondWithListingDetail({ id: req.params.id }, req, res, next);

// URL publique SEO /:categorySlug/:listingSlug (MODULES.md M3) : seul le
// slug de la fiche identifie la ressource, categorySlug n'est utilise que
// pour la lisibilite de l'URL (pas de validation croisee stricte, pour ne
// pas 404 une fiche valide si sa categorie a ete renommee entre-temps).
exports.getListingDetailBySlug = (req, res, next) =>
  respondWithListingDetail({ slug: req.params.listingSlug }, req, res, next);

const EDITABLE_LISTING_FIELDS = [
  'title',
  'description',
  'priceFrom',
  'priceTo',
  'capacityMin',
  'capacity',
  'city',
  'address',
  'googleMapsUrl',
  'phone',
  'website',
  'facebookUrl',
  'instagramUrl',
  'tiktokUrl',
  'linkedinUrl',
  'whatsappUrl',
  'amenities',
  'yearsExperience',
  'languages',
];

exports.getMyListing = async (req, res, next) => {
  try {
    const listing = await Listing.findOne({
      where: { userId: req.user.id },
      include: [
        { model: Category, as: 'category' },
        {
          model: Category,
          as: 'extraCategories',
          attributes: ['id', 'name', 'slug', 'parentId'],
          through: { attributes: [] },
        },
        { model: Image, as: 'images' },
        { model: Video, as: 'videos' },
        { model: Package, as: 'packages' },
        { model: Promotion, as: 'promotions' },
        {
          model: Review,
          as: 'reviews',
          include: [
            { model: User, as: 'author', attributes: ['id', 'firstName'], required: false },
            { model: ReviewPhoto, as: 'photos' },
          ],
        },
      ],
      order: [[{ model: Image, as: 'images' }, 'sortOrder', 'ASC']],
    });

    if (!listing) {
      return res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    }

    return res.json(listing);
  } catch (err) {
    return next(err);
  }
};

// Le prestataire ne modifie QUE sa propre fiche (CLAUDE.md - Contrôle d'accès).
// categoryId et status restent hors de portée : la catégorie est fixée à
// l'inscription, le statut est contrôlé par l'admin (Phase 8).
exports.updateMyListing = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await Listing.findOne({ where: { userId: req.user.id } });
    if (!listing) {
      return res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    }

    EDITABLE_LISTING_FIELDS.forEach((field) => {
      if (req.body[field] !== undefined) listing[field] = req.body[field];
    });

    await listing.save();
    return res.json(listing);
  } catch (err) {
    return next(err);
  }
};

// Remplace la liste des sous-categories SUPPLEMENTAIRES de la fiche (la
// sous-categorie d'inscription reste fixe et compte comme la 1re). Limite :
// Plan.maxCategories du plan reellement applique (Starter 1 = aucune
// supplementaire, Pro 3 = 2 supplementaires, Premium/Elite illimite).
exports.updateMyCategories = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await Listing.findOne({ where: { userId: req.user.id } });
    if (!listing) {
      return res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    }

    const requestedIds = [
      ...new Set((req.body.categoryIds || []).map(Number).filter((id) => id !== Number(listing.categoryId))),
    ];

    const { limits } = await getProviderPlan(req.user.id);
    const maxCategories = limits.maxCategories ?? 1;
    if (requestedIds.length + 1 > maxCategories) {
      return res.status(400).json({
        message: `Votre plan (${limits.label}) autorise au maximum ${maxCategories} catégorie(s), catégorie d'inscription comprise. Passez à un plan supérieur pour en ajouter davantage.`,
      });
    }

    if (requestedIds.length > 0) {
      const validCount = await Category.count({
        where: { id: requestedIds, parentId: { [Op.ne]: null }, isActive: true },
      });
      if (validCount !== requestedIds.length) {
        return res.status(400).json({ message: 'Sous-catégorie invalide.' });
      }
    }

    await db.sequelize.transaction(async (transaction) => {
      await ListingCategory.destroy({ where: { listingId: listing.id }, transaction });
      if (requestedIds.length > 0) {
        await ListingCategory.bulkCreate(
          requestedIds.map((categoryId) => ({ listingId: listing.id, categoryId })),
          { transaction }
        );
      }
    });

    const extraCategories = await Category.findAll({
      where: { id: requestedIds },
      attributes: ['id', 'name', 'slug', 'parentId'],
    });
    return res.json({ extraCategories });
  } catch (err) {
    return next(err);
  }
};

// Supprime l'ancien fichier logo (disque local ou Cloudinary), le cas
// echeant - voir services/storageService.deleteStoredFile.
const removeLogoFile = deleteStoredFile;

// Logo prestataire (module M5) : image distincte de la galerie photos,
// affichee dans l'espace prestataire. Meme pipeline de verification que les
// photos de galerie (magic bytes JPG/PNG, 5 Mo max - CLAUDE.md Uploads).
exports.uploadLogo = async (req, res, next) => {
  try {
    const listing = await Listing.findOne({ where: { userId: req.user.id } });
    if (!listing) {
      return res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    }

    const previousLogoUrl = listing.logoUrl;
    listing.logoUrl = req.uploadedFile.url;
    await listing.save();
    removeLogoFile(previousLogoUrl);

    return res.json(listing);
  } catch (err) {
    return next(err);
  }
};

exports.deleteLogo = async (req, res, next) => {
  try {
    const listing = await Listing.findOne({ where: { userId: req.user.id } });
    if (!listing) {
      return res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    }

    removeLogoFile(listing.logoUrl);
    listing.logoUrl = null;
    await listing.save();

    return res.json(listing);
  } catch (err) {
    return next(err);
  }
};

const VALID_EMAIL_PROVIDERS = ['smtp', 'resend'];

// Config email du prestataire (onglet "Email SMTP" du dashboard, M5) : les
// emails envoyes a SES clients (factures/contrats) partent alors de sa
// propre identite plutot que du SMTP central de la plateforme - voir
// services/emailService.js. Le secret (mot de passe SMTP / cle API Resend)
// n'est JAMAIS renvoye au frontend, ni en clair ni chiffre - seul un
// booleen indique s'il est deja enregistre (CLAUDE.md - secrets jamais
// exposes).
exports.getMyEmailSettings = async (req, res, next) => {
  try {
    const listing = await Listing.findOne({ where: { userId: req.user.id } });
    if (!listing) {
      return res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    }

    const settings = listing.emailSettings || {};
    return res.json({
      provider: settings.provider || null,
      host: settings.host || '',
      port: settings.port || '',
      user: settings.user || '',
      fromEmail: settings.fromEmail || '',
      hasPassword: Boolean(settings.passEncrypted),
      hasApiKey: Boolean(settings.apiKeyEncrypted),
    });
  } catch (err) {
    return next(err);
  }
};

exports.updateMyEmailSettings = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await Listing.findOne({ where: { userId: req.user.id } });
    if (!listing) {
      return res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    }

    const { provider, host, port, user, fromEmail, pass, apiKey } = req.body;

    if (provider !== undefined && provider !== null && !VALID_EMAIL_PROVIDERS.includes(provider)) {
      return res.status(400).json({ message: 'Fournisseur email invalide.' });
    }

    const previous = listing.emailSettings || {};
    const next_ = {
      provider: provider !== undefined ? provider : previous.provider || null,
      host: host !== undefined ? host : previous.host || '',
      port: port !== undefined ? port : previous.port || '',
      user: user !== undefined ? user : previous.user || '',
      fromEmail: fromEmail !== undefined ? fromEmail : previous.fromEmail || '',
      // pass/apiKey non fournis = on conserve le secret deja enregistre ;
      // chaine vide explicite = suppression volontaire.
      passEncrypted: pass !== undefined ? (pass ? encrypt(pass) : null) : previous.passEncrypted || null,
      apiKeyEncrypted: apiKey !== undefined ? (apiKey ? encrypt(apiKey) : null) : previous.apiKeyEncrypted || null,
    };

    listing.emailSettings = next_;
    await listing.save();

    return res.json({
      provider: next_.provider,
      host: next_.host,
      port: next_.port,
      user: next_.user,
      fromEmail: next_.fromEmail,
      hasPassword: Boolean(next_.passEncrypted),
      hasApiKey: Boolean(next_.apiKeyEncrypted),
    });
  } catch (err) {
    return next(err);
  }
};

exports.sendMyTestEmail = async (req, res, next) => {
  try {
    const listing = await Listing.findOne({ where: { userId: req.user.id } });
    if (!listing) {
      return res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    }

    const to = req.body.to || req.user.email;
    if (!to) {
      return res.status(400).json({ message: 'Adresse email de destination requise.' });
    }

    await emailService.sendTestEmail(listing, to);
    return res.json({ message: `Email de test envoyé à ${to}.` });
  } catch (err) {
    return res.status(422).json({
      message: `Échec de l'envoi : ${err.message || 'vérifiez votre configuration.'}`,
    });
  }
};

exports.getSimilarListings = async (req, res, next) => {
  try {
    const { id } = req.params;
    const listing = await Listing.findByPk(id);

    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }

    const similar = await Listing.findAll({
      where: {
        id: { [Op.ne]: listing.id },
        categoryId: listing.categoryId,
        city: listing.city,
        status: 'active',
      },
      include: [
        {
          model: Image,
          as: 'images',
          required: false,
          separate: true,
          where: { isPrimary: true },
          limit: 1,
        },
      ],
      limit: 4,
      order: [['ratingAvg', 'DESC']],
    });

    return res.json(similar);
  } catch (err) {
    return next(err);
  }
};
