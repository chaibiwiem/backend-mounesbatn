// Insère les 8 catégories principales + 28 sous-catégories (types de
// prestataires), exactement comme dans docs/farahbooking_schema.sql, puis
// quelques prestataires et avis de démonstration.

const bcrypt = require('bcrypt');
const db = require('./models');
const { PLAN_CATALOG } = require('./services/planService');
const { generateUniqueListingSlug } = require('./utils/slugify');

const { User, Category, Listing, Booking, Review, Subscription } = db;

const mainCategories = [
  { name: 'Lieux de mariage', slug: 'lieux-de-mariage', icon: 'building', sortOrder: 1 },
  { name: 'Beauté & Bien-être', slug: 'beaute-bien-etre', icon: 'sparkles', sortOrder: 2 },
  { name: 'Décoration', slug: 'decoration', icon: 'confetti', sortOrder: 3 },
  { name: 'Traiteur & Pâtisserie', slug: 'traiteur-patisserie', icon: 'cake', sortOrder: 4 },
  { name: 'Mode', slug: 'mode', icon: 'shirt', sortOrder: 5 },
  { name: 'Image & Médias', slug: 'image-medias', icon: 'camera', sortOrder: 6 },
  { name: 'Transport', slug: 'transport', icon: 'car', sortOrder: 7 },
  { name: 'Animation', slug: 'animation', icon: 'music', sortOrder: 8 },
];

const subCategories = {
  'lieux-de-mariage': [
    { name: 'Salle de fête', slug: 'salle-de-fete', sortOrder: 1 },
    { name: 'Villa événementielle', slug: 'villa', sortOrder: 2 },
    { name: 'Hôtel', slug: 'hotel', sortOrder: 3 },
    { name: "Maison d'hôte", slug: 'maison-hote', sortOrder: 4 },
    { name: 'Restaurant', slug: 'restaurant', sortOrder: 5 },
  ],
  'beaute-bien-etre': [
    { name: 'Salon de beauté', slug: 'salon-beaute', sortOrder: 1 },
    { name: 'Coiffure femme', slug: 'coiffure-femme', sortOrder: 2 },
    { name: 'Coiffure homme', slug: 'coiffure-homme', sortOrder: 3 },
    { name: 'Spa & Bien-être', slug: 'spa', sortOrder: 4 },
    { name: 'Hammam', slug: 'hammam', sortOrder: 5 },
  ],
  decoration: [
    { name: 'Décoration de fête', slug: 'deco-fete', sortOrder: 1 },
    { name: "Décoration d'anniversaire", slug: 'deco-anniversaire', sortOrder: 2 },
    { name: 'Fleuriste', slug: 'fleuriste', sortOrder: 3 },
    { name: 'Location de matériel', slug: 'location-materiel', sortOrder: 4 },
  ],
  'traiteur-patisserie': [
    { name: 'Traiteur', slug: 'traiteur', sortOrder: 1 },
    { name: 'Pâtisserie', slug: 'patisserie', sortOrder: 2 },
    { name: 'Salé & Sucré', slug: 'sale-sucre', sortOrder: 3 },
  ],
  mode: [
    { name: 'Location de robes', slug: 'location-robes', sortOrder: 1 },
    { name: 'Location de costumes', slug: 'location-costumes', sortOrder: 2 },
  ],
  'image-medias': [
    { name: 'Photographie & Vidéo', slug: 'photo-video', sortOrder: 1 },
    { name: "Cartes d'invitation", slug: 'cartes-invitation', sortOrder: 2 },
  ],
  transport: [
    { name: 'Location de voitures', slug: 'location-voitures', sortOrder: 1 },
    { name: 'Location de bus', slug: 'location-bus', sortOrder: 2 },
  ],
  animation: [
    { name: 'DJ', slug: 'dj', sortOrder: 1 },
    { name: 'Animation enfants', slug: 'animation-enfants', sortOrder: 2 },
    { name: 'Magicien', slug: 'magicien', sortOrder: 3 },
    { name: 'Groupe musical traditionnel', slug: 'groupe-musical', sortOrder: 4 },
  ],
};

async function seedCategories() {
  const parentsBySlug = {};

  for (const cat of mainCategories) {
    const [category] = await Category.findOrCreate({
      where: { slug: cat.slug },
      defaults: cat,
    });
    parentsBySlug[cat.slug] = category;
  }

  for (const [parentSlug, children] of Object.entries(subCategories)) {
    const parent = parentsBySlug[parentSlug];
    for (const child of children) {
      await Category.findOrCreate({
        where: { slug: child.slug },
        defaults: { ...child, parentId: parent.id },
      });
    }
  }
}

async function seedDemoData() {
  const passwordHash = await bcrypt.hash('Password123!', 12);

  const [client] = await User.findOrCreate({
    where: { email: 'client.demo@mounesba.tn' },
    defaults: {
      role: 'client',
      firstName: 'Amina',
      lastName: 'Ben Salah',
      email: 'client.demo@mounesba.tn',
      phone: '+21620000001',
      passwordHash,
      emailVerified: true,
    },
  });

  await User.findOrCreate({
    where: { email: 'admin.demo@mounesba.tn' },
    defaults: {
      role: 'admin',
      adminRole: 'super_admin',
      firstName: 'Admin',
      lastName: 'Mounesba',
      email: 'admin.demo@mounesba.tn',
      phone: '+21620000000',
      passwordHash,
      emailVerified: true,
    },
  });

  // Comptes de demo pour tester les autres sous-roles admin (M10).
  const demoAdminSubRoles = [
    { adminRole: 'moderator', firstName: 'Moderateur', email: 'moderateur.demo@mounesba.tn', phone: '+21620000010' },
    { adminRole: 'support', firstName: 'Support', email: 'support.demo@mounesba.tn', phone: '+21620000011' },
    { adminRole: 'analyst', firstName: 'Analyste', email: 'analyste.demo@mounesba.tn', phone: '+21620000012' },
  ];
  for (const admin of demoAdminSubRoles) {
    await User.findOrCreate({
      where: { email: admin.email },
      defaults: {
        role: 'admin',
        adminRole: admin.adminRole,
        firstName: admin.firstName,
        lastName: 'Mounesba',
        email: admin.email,
        phone: admin.phone,
        passwordHash,
        emailVerified: true,
      },
    });
  }

  const djCategory = await Category.findOne({ where: { slug: 'dj' } });
  const traiteurCategory = await Category.findOne({ where: { slug: 'traiteur' } });

  const providersData = [
    {
      user: {
        firstName: 'Karim',
        lastName: 'Mzoughi',
        email: 'dj.karim@mounesba.tn',
        phone: '+21620000002',
      },
      listing: {
        title: 'DJ Karim Events',
        description: 'Animation musicale pour mariages et fiançailles partout en Tunisie.',
        priceFrom: 800,
        priceTo: 2500,
        city: 'Tunis',
        category: djCategory,
        ratingAvg: 4.5,
        ratingCount: 1,
      },
      plan: 'premium',
    },
    {
      user: {
        firstName: 'Sonia',
        lastName: 'Trabelsi',
        email: 'traiteur.sonia@mounesba.tn',
        phone: '+21620000003',
      },
      listing: {
        title: 'Traiteur Sonia',
        description: 'Buffets et plateaux traditionnels tunisiens pour tous vos événements.',
        priceFrom: 25,
        priceTo: 60,
        city: 'Sousse',
        category: traiteurCategory,
        ratingAvg: 5.0,
        ratingCount: 1,
      },
      plan: 'starter',
    },
  ];

  for (const p of providersData) {
    const [providerUser] = await User.findOrCreate({
      where: { email: p.user.email },
      defaults: {
        role: 'provider',
        firstName: p.user.firstName,
        lastName: p.user.lastName,
        email: p.user.email,
        phone: p.user.phone,
        passwordHash,
        emailVerified: true,
      },
    });

    const [listing] = await Listing.findOrCreate({
      where: { userId: providerUser.id, title: p.listing.title },
      defaults: {
        userId: providerUser.id,
        categoryId: p.listing.category.id,
        title: p.listing.title,
        slug: await generateUniqueListingSlug(Listing, p.listing.title),
        description: p.listing.description,
        priceFrom: p.listing.priceFrom,
        priceTo: p.listing.priceTo,
        city: p.listing.city,
        status: 'active',
        ratingAvg: p.listing.ratingAvg,
        ratingCount: p.listing.ratingCount,
      },
    });

    await Subscription.findOrCreate({
      where: { userId: providerUser.id },
      defaults: {
        userId: providerUser.id,
        plan: p.plan,
        price: PLAN_CATALOG[p.plan].price,
        billingCycle: 'monthly',
        status: 'active',
        startDate: new Date().toISOString().slice(0, 10),
        endDate: p.plan === 'starter' ? null : '2026-08-10',
      },
    });

    const [booking] = await Booking.findOrCreate({
      where: { listingId: listing.id, userId: client.id },
      defaults: {
        listingId: listing.id,
        userId: client.id,
        eventDate: '2026-05-10',
        status: 'completed',
        totalPrice: p.listing.priceFrom,
        paymentMethod: 'cash',
      },
    });

    await Review.findOrCreate({
      where: { bookingId: booking.id },
      defaults: {
        bookingId: booking.id,
        listingId: listing.id,
        userId: client.id,
        rating: 5,
        title: 'Une prestation au-delà de nos attentes',
        recommend: true,
        qualityRating: 5,
        responseTimeRating: 5,
        professionalismRating: 5,
        valueRating: 5,
        flexibilityRating: 5,
        comment:
          "Prestation excellente, très professionnel ! L'équipe s'est parfaitement adaptée à notre budget et à nos horaires, je recommande sans hésiter.",
        isVerified: true,
      },
    });
  }
}

// Table `plans` (Parametres admin > Plans & Tarifs) : findOrCreate ligne par
// ligne pour ne jamais ecraser un prix/description deja modifie par un admin
// en relancant ce script.
async function seedPlans() {
  for (const [key, plan] of Object.entries(PLAN_CATALOG)) {
    await db.Plan.findOrCreate({
      where: { key },
      defaults: {
        key,
        label: plan.label,
        description: plan.description || '',
        price: plan.price,
        priceYearly: plan.priceYearly,
        maxPhotos: plan.maxPhotos === Infinity ? null : plan.maxPhotos,
        maxVideos: plan.maxVideos === Infinity ? null : plan.maxVideos,
        maxPromotions: plan.maxPromotions === Infinity ? null : plan.maxPromotions,
        featured: plan.featured,
        eventsEnabled: plan.eventsEnabled,
        calendarEnabled: plan.calendarEnabled,
        maxVehicles: plan.maxVehicles === Infinity ? null : plan.maxVehicles,
        maxCategories: plan.maxCategories === Infinity ? null : plan.maxCategories,
      },
    });
  }
}

async function run() {
  await db.sequelize.sync();
  await seedCategories();
  await seedPlans();
  await seedDemoData();
  console.log('Seed terminé : 8 catégories + 28 sous-catégories + plans + données de démo.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Erreur lors du seed :', err);
  process.exit(1);
});
