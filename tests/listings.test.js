process.env.DATABASE_URL = '';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'root';
process.env.DB_PASS = process.env.DB_PASS || '';
process.env.DB_NAME = 'farahbooking_test';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';

const request = require('supertest');
const db = require('../src/models');
const app = require('../src/app');

const { Category, User, Listing, Image, Package, Promotion, Booking, Review, Subscription } = db;

let parentCategory;
let djCategory;
let activeListing;
let pendingListing;

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  parentCategory = await Category.create({ name: 'Animation', slug: 'animation', sortOrder: 1 });
  djCategory = await Category.create({
    name: 'DJ',
    slug: 'dj',
    parentId: parentCategory.id,
    sortOrder: 1,
  });

  const provider = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Mzoughi',
    email: 'dj.karim.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  const otherProvider = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Prestataire',
    email: 'autre.provider.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  activeListing = await Listing.create({
    userId: provider.id,
    categoryId: djCategory.id,
    title: 'DJ Karim Events',
    slug: 'dj-karim-events',
    description: 'Animation musicale pour mariages',
    priceFrom: 800,
    priceTo: 2500,
    city: 'Tunis',
    status: 'active',
    ratingAvg: 4.5,
    ratingCount: 1,
    viewsCount: 10,
  });

  pendingListing = await Listing.create({
    userId: otherProvider.id,
    categoryId: djCategory.id,
    title: 'DJ Non Valide',
    city: 'Tunis',
    status: 'pending',
  });

  await Image.create({ listingId: activeListing.id, url: '/img1.jpg', isPrimary: true, sortOrder: 0 });
  await Package.create({ listingId: activeListing.id, name: 'Pack Soiree', price: 1200, priceType: 'from' });
  await Promotion.create({
    listingId: activeListing.id,
    type: 'percent',
    value: 10,
    label: '-10% nouveaux clients',
    isActive: true,
  });

  const client = await User.create({
    role: 'client',
    firstName: 'Amina',
    lastName: 'Client',
    email: 'client.review.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  const booking = await Booking.create({
    listingId: activeListing.id,
    userId: client.id,
    status: 'completed',
    eventDate: '2026-01-10',
  });

  await Review.create({
    bookingId: booking.id,
    listingId: activeListing.id,
    userId: client.id,
    rating: 5,
    title: 'Super prestation',
    recommend: true,
    qualityRating: 5,
    responseTimeRating: 5,
    professionalismRating: 5,
    valueRating: 5,
    flexibilityRating: 5,
    comment: 'Super prestation',
    isVerified: true,
  });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('GET /api/categories', () => {
  test('renvoie un arbre avec les sous-categories imbriquees', async () => {
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);

    const animation = res.body.find((c) => c.slug === 'animation');
    expect(animation).toBeDefined();
    expect(animation.children.some((c) => c.slug === 'dj')).toBe(true);
  });
});

describe('GET /api/listings', () => {
  test('ne renvoie que les fiches actives (exclut pending)', async () => {
    const res = await request(app).get('/api/listings');
    expect(res.status).toBe(200);
    const ids = res.body.results.map((l) => l.id);
    expect(ids).toContain(activeListing.id);
    expect(ids).not.toContain(pendingListing.id);
  });

  test('filtre par ville et categorie (sous-categorie)', async () => {
    const res = await request(app)
      .get('/api/listings')
      .query({ city: 'Tunis', category: 'dj' });
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    res.body.results.forEach((l) => expect(l.city).toBe('Tunis'));
  });

  test('filtre par categorie principale : inclut les fiches de ses sous-categories', async () => {
    const res = await request(app).get('/api/listings').query({ category: 'animation' });
    expect(res.status).toBe(200);
    expect(res.body.results.map((l) => l.id)).toContain(activeListing.id);
  });

  test('filtre par note minimale', async () => {
    const res = await request(app).get('/api/listings').query({ minRating: 4.6 });
    expect(res.status).toBe(200);
    expect(res.body.results.find((l) => l.id === activeListing.id)).toBeUndefined();
  });

  test('trie par prix croissant', async () => {
    const res = await request(app).get('/api/listings').query({ sort: 'price_asc' });
    expect(res.status).toBe(200);
    const prices = res.body.results.map((l) => Number(l.priceFrom));
    const sorted = [...prices].sort((a, b) => a - b);
    expect(prices).toEqual(sorted);
  });

  test('tri par defaut avec un abonne Premium actif (regression : colonne non qualifiee dans le tri SQL)', async () => {
    const premiumProvider = await User.create({
      role: 'provider',
      firstName: 'Premium',
      lastName: 'Provider',
      email: 'premium.provider.test@example.com',
      passwordHash: 'hash',
      emailVerified: true,
    });
    await Subscription.create({
      userId: premiumProvider.id,
      plan: 'premium',
      status: 'active',
      startDate: '2026-01-01',
    });

    // Le bug (colonne `user_id` non qualifiee dans le CASE de tri) faisait
    // echouer TOUTE recherche par defaut des qu'un abonne Premium existait,
    // meme sans filtre - d'ou le "0 resultat" cote client.
    const res = await request(app).get('/api/listings');
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
  });
});

describe('GET /api/listings/:id', () => {
  test('renvoie le detail complet et incremente viewsCount', async () => {
    const before = await Listing.findByPk(activeListing.id);
    const res = await request(app).get(`/api/listings/${activeListing.id}`);

    expect(res.status).toBe(200);
    expect(res.body.packages.length).toBe(1);
    expect(res.body.promotions.length).toBe(1);
    expect(res.body.reviews.length).toBe(1);
    expect(res.body.ratingBreakdown.find((r) => r.star === 5).count).toBe(1);

    const after = await Listing.findByPk(activeListing.id);
    expect(after.viewsCount).toBe(before.viewsCount + 1);
  });

  test('renvoie 404 pour une fiche pending (non publique)', async () => {
    const res = await request(app).get(`/api/listings/${pendingListing.id}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/listings/slug/:categorySlug/:listingSlug', () => {
  test('renvoie la fiche via son slug (URL publique SEO)', async () => {
    const res = await request(app).get(`/api/listings/slug/${djCategory.slug}/dj-karim-events`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(activeListing.id);
    expect(res.body.slug).toBe('dj-karim-events');
  });

  test('le segment categorySlug est ignore pour la resolution (pas de 404 si obsolete)', async () => {
    const res = await request(app).get('/api/listings/slug/categorie-obsolete/dj-karim-events');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(activeListing.id);
  });

  test('renvoie 404 pour un slug inconnu', async () => {
    const res = await request(app).get(`/api/listings/slug/${djCategory.slug}/inconnu-xyz`);
    expect(res.status).toBe(404);
  });

  test('renvoie 404 pour le slug d\'une fiche pending (non publique)', async () => {
    await pendingListing.update({ slug: 'dj-non-valide' });
    const res = await request(app).get(`/api/listings/slug/${djCategory.slug}/dj-non-valide`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/listings/:id/similar', () => {
  test('renvoie les prestataires similaires (meme categorie + ville)', async () => {
    const otherProvider = await User.create({
      role: 'provider',
      firstName: 'Autre',
      lastName: 'DJ',
      email: 'autre.dj.test@example.com',
      passwordHash: 'hash',
      emailVerified: true,
    });
    const similarListing = await Listing.create({
      userId: otherProvider.id,
      categoryId: djCategory.id,
      title: 'DJ Similaire',
      city: 'Tunis',
      status: 'active',
    });

    const res = await request(app).get(`/api/listings/${activeListing.id}/similar`);
    expect(res.status).toBe(200);
    expect(res.body.some((l) => l.id === similarListing.id)).toBe(true);
    expect(res.body.some((l) => l.id === activeListing.id)).toBe(false);
  });
});
