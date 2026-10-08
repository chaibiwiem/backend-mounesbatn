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
const jwt = require('jsonwebtoken');
const db = require('../src/models');
const app = require('../src/app');

const { Category, User, Listing, Subscription } = db;

let caterer;
let pastry;
let cakes;
let sweets;
let provider;
let listing;
let subscription;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function setPlan(plan, endDate = null) {
  subscription.plan = plan;
  subscription.status = 'active';
  subscription.endDate = endDate;
  await subscription.save();
}

function searchSlugs(slug) {
  return request(app)
    .get('/api/listings')
    .query({ category: slug })
    .then((res) => res.body.results.map((l) => l.id));
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  const food = await Category.create({ name: 'Traiteur & Pâtisserie', slug: 'traiteur-patisserie' });
  caterer = await Category.create({ name: 'Traiteur', slug: 'traiteur-cat-test', parentId: food.id });
  pastry = await Category.create({ name: 'Pâtisserie', slug: 'patisserie-cat-test', parentId: food.id });
  cakes = await Category.create({ name: 'Gâteaux', slug: 'gateaux-cat-test', parentId: food.id });
  sweets = await Category.create({ name: 'Douceurs', slug: 'douceurs-cat-test', parentId: food.id });

  provider = await User.create({
    role: 'provider',
    firstName: 'Mouna',
    lastName: 'Traiteur',
    email: 'provider.categories.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });
  listing = await Listing.create({
    userId: provider.id,
    categoryId: caterer.id,
    title: 'Mouna Traiteur',
    city: 'Tunis',
    status: 'active',
  });
  subscription = await Subscription.create({
    userId: provider.id,
    plan: 'starter',
    price: 0,
    billingCycle: 'monthly',
    status: 'active',
    startDate: new Date().toISOString().slice(0, 10),
  });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('PUT /api/listings/me/categories', () => {
  test('Starter (1 categorie) : aucune sous-categorie supplementaire (400)', async () => {
    await setPlan('starter');
    const res = await request(app)
      .put('/api/listings/me/categories')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ categoryIds: [pastry.id] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Starter/);
  });

  test('Pro (3 categories) : accepte 2 supplementaires, refuse une 3e', async () => {
    await setPlan('pro');
    const ok = await request(app)
      .put('/api/listings/me/categories')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ categoryIds: [pastry.id, cakes.id] });
    expect(ok.status).toBe(200);
    expect(ok.body.extraCategories.map((c) => c.id).sort()).toEqual([pastry.id, cakes.id].sort());

    const tooMany = await request(app)
      .put('/api/listings/me/categories')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ categoryIds: [pastry.id, cakes.id, sweets.id] });
    expect(tooMany.status).toBe(400);
  });

  test('la categorie d\'inscription envoyee en double n\'est pas comptee', async () => {
    await setPlan('pro');
    const res = await request(app)
      .put('/api/listings/me/categories')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ categoryIds: [caterer.id, pastry.id, cakes.id] });
    expect(res.status).toBe(200);
    expect(res.body.extraCategories).toHaveLength(2);
  });

  test('refuse une categorie principale (non sous-categorie)', async () => {
    await setPlan('premium');
    const food = await Category.findOne({ where: { slug: 'traiteur-patisserie' } });
    const res = await request(app)
      .put('/api/listings/me/categories')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ categoryIds: [food.id] });
    expect(res.status).toBe(400);
  });

  test('Premium (illimite) : accepte 3 supplementaires', async () => {
    await setPlan('premium');
    const res = await request(app)
      .put('/api/listings/me/categories')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ categoryIds: [pastry.id, cakes.id, sweets.id] });
    expect(res.status).toBe(200);
    expect(res.body.extraCategories).toHaveLength(3);
  });

  test('GET /api/listings/me renvoie les sous-categories supplementaires', async () => {
    const res = await request(app)
      .get('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(provider)}`);
    expect(res.status).toBe(200);
    expect(res.body.extraCategories).toHaveLength(3);
  });
});

describe('Recherche par categorie et sous-categories supplementaires', () => {
  test('la fiche apparait dans ses sous-categories supplementaires autorisees', async () => {
    await setPlan('premium');
    expect(await searchSlugs('traiteur-cat-test')).toContain(listing.id);
    expect(await searchSlugs('douceurs-cat-test')).toContain(listing.id);
  });

  test('apres retrogradation en Pro, seules les 2 premieres supplementaires restent visibles', async () => {
    await setPlan('pro');
    expect(await searchSlugs('patisserie-cat-test')).toContain(listing.id);
    expect(await searchSlugs('gateaux-cat-test')).toContain(listing.id);
    expect(await searchSlugs('douceurs-cat-test')).not.toContain(listing.id);
  });

  test('abonnement expire : retombe sur Starter, plus aucune categorie supplementaire', async () => {
    await setPlan('premium', '2020-01-01');
    expect(await searchSlugs('patisserie-cat-test')).not.toContain(listing.id);
    // La categorie d'inscription, elle, reste toujours visible.
    expect(await searchSlugs('traiteur-cat-test')).toContain(listing.id);
  });
});
