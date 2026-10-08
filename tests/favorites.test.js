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

const { Category, User, Listing } = db;

let category;
let providerUser;
let listing;
let otherListing;
let clientUser;
let otherClientUser;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  category = await Category.create({ name: 'DJ', slug: 'dj-favorites-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Mzoughi',
    email: 'provider.favorites.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  listing = await Listing.create({
    userId: providerUser.id,
    categoryId: category.id,
    title: 'DJ Karim Events',
    city: 'Tunis',
    status: 'active',
  });

  otherListing = await Listing.create({
    userId: providerUser.id,
    categoryId: category.id,
    title: 'DJ Karim Events 2',
    city: 'Sousse',
    status: 'pending',
  });

  clientUser = await User.create({
    role: 'client',
    firstName: 'Amina',
    lastName: 'Ben Salah',
    email: 'client.favorites.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherClientUser = await User.create({
    role: 'client',
    firstName: 'Sami',
    lastName: 'Trabelsi',
    email: 'client2.favorites.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('Favoris (M11)', () => {
  test('un client peut ajouter un prestataire en favori', async () => {
    const res = await request(app)
      .post('/api/favorites')
      .set('Authorization', `Bearer ${tokenFor(clientUser)}`)
      .send({ listingId: listing.id });

    expect(res.status).toBe(201);
    expect(Number(res.body.listingId)).toBe(listing.id);
  });

  test('ajouter deux fois le meme favori ne cree pas de doublon', async () => {
    const res = await request(app)
      .post('/api/favorites')
      .set('Authorization', `Bearer ${tokenFor(clientUser)}`)
      .send({ listingId: listing.id });

    expect(res.status).toBe(201);

    const count = await db.Favorite.count({ where: { userId: clientUser.id, listingId: listing.id } });
    expect(count).toBe(1);
  });

  test('impossible de mettre en favori un prestataire non actif', async () => {
    const res = await request(app)
      .post('/api/favorites')
      .set('Authorization', `Bearer ${tokenFor(clientUser)}`)
      .send({ listingId: otherListing.id });

    expect(res.status).toBe(404);
  });

  test('GET /api/favorites/me retourne uniquement les favoris du client connecte', async () => {
    const res = await request(app)
      .get('/api/favorites/me')
      .set('Authorization', `Bearer ${tokenFor(clientUser)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(listing.id);

    const otherRes = await request(app)
      .get('/api/favorites/me')
      .set('Authorization', `Bearer ${tokenFor(otherClientUser)}`);

    expect(otherRes.status).toBe(200);
    expect(otherRes.body).toHaveLength(0);
  });

  test('la fiche prestataire affiche isFavorited pour le client qui a favorise', async () => {
    const resFavorited = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set('Authorization', `Bearer ${tokenFor(clientUser)}`);
    expect(resFavorited.status).toBe(200);
    expect(resFavorited.body.isFavorited).toBe(true);

    const resNotFavorited = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set('Authorization', `Bearer ${tokenFor(otherClientUser)}`);
    expect(resNotFavorited.body.isFavorited).toBe(false);

    const resAnonymous = await request(app).get(`/api/listings/${listing.id}`);
    expect(resAnonymous.status).toBe(200);
    expect(resAnonymous.body.isFavorited).toBe(false);
  });

  test('un prestataire ne peut pas ajouter de favori (role client uniquement)', async () => {
    const res = await request(app)
      .post('/api/favorites')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ listingId: listing.id });

    expect(res.status).toBe(403);
  });

  test('DELETE /api/favorites/:listingId retire le favori', async () => {
    const res = await request(app)
      .delete(`/api/favorites/${listing.id}`)
      .set('Authorization', `Bearer ${tokenFor(clientUser)}`);

    expect(res.status).toBe(204);

    const count = await db.Favorite.count({ where: { userId: clientUser.id, listingId: listing.id } });
    expect(count).toBe(0);
  });

  test('supprimer un favori inexistant ne renvoie pas d\'erreur', async () => {
    const res = await request(app)
      .delete(`/api/favorites/${listing.id}`)
      .set('Authorization', `Bearer ${tokenFor(clientUser)}`);

    expect(res.status).toBe(204);
  });

  test('acces sans authentification refuse', async () => {
    const res = await request(app).get('/api/favorites/me');
    expect(res.status).toBe(401);
  });
});
