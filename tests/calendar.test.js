process.env.DATABASE_URL = '';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'root';
process.env.DB_PASS = process.env.DB_PASS || '';
process.env.DB_NAME = 'farahbooking_test';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_EXPIRES_IN = '1h';
process.env.JWT_REFRESH_SECRET = 'test_jwt_refresh_secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/models');
const app = require('../src/app');

const { Category, User, Listing, Client, Booking, Availability } = db;

let category;
let providerUser;
let otherProviderUser;
let adminUser;
let listing;
let client;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  category = await Category.create({ name: 'DJ', slug: 'dj-calendar-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Mzoughi',
    email: 'provider.calendar.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherProviderUser = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Prestataire',
    email: 'other.provider.calendar.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  adminUser = await User.create({
    role: 'admin',
    firstName: 'Admin',
    lastName: 'Mounesba',
    email: 'admin.calendar.test@example.com',
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

  client = await Client.create({
    listingId: listing.id,
    name: 'Sami Trabelsi',
    email: 'sami.calendar.test@example.com',
    phone: '+21620000088',
  });

  // Dans la periode testee (2026-09-01 -> 2026-09-30).
  await Booking.create({
    listingId: listing.id,
    clientId: client.id,
    eventDate: '2026-09-10',
    startTime: '14:00',
    endTime: '18:00',
    status: 'confirmed',
    totalPrice: 1500,
  });
  // Hors periode testee - ne doit jamais apparaitre dans la reponse.
  await Booking.create({
    listingId: listing.id,
    clientId: client.id,
    eventDate: '2026-10-05',
    status: 'pending',
  });

  await Availability.create({ listingId: listing.id, date: '2026-09-15', isAvailable: false });
  // Hors periode testee.
  await Availability.create({ listingId: listing.id, date: '2026-10-15', isAvailable: false });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('GET /api/listings/:id/calendar', () => {
  test('refuse une requete sans token (401)', async () => {
    const res = await request(app).get(
      `/api/listings/${listing.id}/calendar?from=2026-09-01&to=2026-09-30`
    );
    expect(res.status).toBe(401);
  });

  test("refuse l'acces a un prestataire qui n'est pas proprietaire (403)", async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/calendar?from=2026-09-01&to=2026-09-30`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);
    expect(res.status).toBe(403);
  });

  test('refuse une requete sans from/to (400)', async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/calendar`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(res.status).toBe(400);
  });

  test('renvoie 404 pour une fiche inexistante', async () => {
    const res = await request(app)
      .get('/api/listings/999999/calendar?from=2026-09-01&to=2026-09-30')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(res.status).toBe(404);
  });

  test('le proprietaire charge uniquement les bookings/availability de la plage demandee', async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/calendar?from=2026-09-01&to=2026-09-30`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].eventDate).toBe('2026-09-10');
    expect(res.body.bookings[0].startTime).toBe('14:00:00');
    expect(res.body.bookings[0].endTime).toBe('18:00:00');
    expect(res.body.bookings[0].client.name).toBe('Sami Trabelsi');

    expect(res.body.availability).toHaveLength(1);
    expect(res.body.availability[0].date).toBe('2026-09-15');
    expect(res.body.availability[0].isAvailable).toBe(false);
  });

  test('un admin peut consulter le calendrier de nimporte quelle fiche', async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/calendar?from=2026-09-01&to=2026-09-30`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
  });

  test('une plage sans donnees renvoie des tableaux vides (pas une erreur)', async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/calendar?from=2027-01-01&to=2027-01-31`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(0);
    expect(res.body.availability).toHaveLength(0);
  });
});
