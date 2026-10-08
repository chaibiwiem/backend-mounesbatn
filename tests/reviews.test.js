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

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/models');
const app = require('../src/app');

const { Category, User, Listing, Booking, Review, Dispute } = db;

let category;
let providerUser;
let otherProviderUser;
let clientUser;
let otherClientUser;
let listing;
let completedBooking;
let pendingBooking;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)]);
const FAKE_TEXT = Buffer.from('pas une image');
const REVIEWS_DIR = path.join(__dirname, '../uploads/reviews');

const VALID_FIELDS = {
  title: 'Une prestation vraiment au top',
  comment:
    "Le prestataire s'est parfaitement adapte a notre budget et a ete tres professionnel du debut a la fin.",
  recommend: true,
  qualityRating: 5,
  responseTimeRating: 5,
  professionalismRating: 5,
  valueRating: 5,
  flexibilityRating: 5,
};

function attachFields(req, overrides = {}) {
  const fields = { ...VALID_FIELDS, ...overrides };
  Object.entries(fields).forEach(([key, value]) => req.field(key, value));
  return req;
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  category = await Category.create({ name: 'DJ', slug: 'dj-reviews-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Mzoughi',
    email: 'provider.reviews.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherProviderUser = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Prestataire',
    email: 'other.provider.reviews.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  clientUser = await User.create({
    role: 'client',
    firstName: 'Amina',
    lastName: 'Client',
    email: 'client.reviews.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherClientUser = await User.create({
    role: 'client',
    firstName: 'Sami',
    lastName: 'AutreClient',
    email: 'other.client.reviews.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  listing = await Listing.create({
    userId: providerUser.id,
    categoryId: category.id,
    title: 'DJ Karim Events',
    city: 'Tunis',
    status: 'active',
    ratingAvg: 0,
    ratingCount: 0,
  });

  completedBooking = await Booking.create({
    listingId: listing.id,
    userId: clientUser.id,
    status: 'completed',
    eventDate: '2026-01-10',
  });

  pendingBooking = await Booking.create({
    listingId: listing.id,
    userId: clientUser.id,
    status: 'pending',
    eventDate: '2026-06-10',
  });
});

afterAll(async () => {
  await db.sequelize.close();
  if (fs.existsSync(REVIEWS_DIR)) {
    fs.readdirSync(REVIEWS_DIR).forEach((file) => fs.unlinkSync(`${REVIEWS_DIR}/${file}`));
  }
});

describe('POST /api/reviews', () => {
  test('refuse une note hors de 1-5 (400)', async () => {
    const res = await attachFields(
      request(app).post('/api/reviews').set('Authorization', `Bearer ${tokenFor(clientUser)}`).field('bookingId', completedBooking.id),
      { qualityRating: 7 }
    );

    expect(res.status).toBe(400);
  });

  test("refuse un avis sur une reservation d'un autre client (403)", async () => {
    const res = await attachFields(
      request(app)
        .post('/api/reviews')
        .set('Authorization', `Bearer ${tokenFor(otherClientUser)}`)
        .field('bookingId', completedBooking.id)
    );

    expect(res.status).toBe(403);
  });

  test("refuse un avis sur une reservation non terminee (403)", async () => {
    const res = await attachFields(
      request(app)
        .post('/api/reviews')
        .set('Authorization', `Bearer ${tokenFor(clientUser)}`)
        .field('bookingId', pendingBooking.id)
    );

    expect(res.status).toBe(403);
  });

  test('rejette une photo invalide (magic bytes) avec 400', async () => {
    const res = await attachFields(
      request(app)
        .post('/api/reviews')
        .set('Authorization', `Bearer ${tokenFor(clientUser)}`)
        .field('bookingId', completedBooking.id)
    ).attach('photos', FAKE_TEXT, 'fake.jpg');

    expect(res.status).toBe(400);

    const review = await Review.findOne({ where: { bookingId: completedBooking.id } });
    expect(review).toBeNull();
  });

  test('cree un avis verifie avec photo et recalcule la note moyenne', async () => {
    const res = await attachFields(
      request(app)
        .post('/api/reviews')
        .set('Authorization', `Bearer ${tokenFor(clientUser)}`)
        .field('bookingId', completedBooking.id)
    ).attach('photos', FAKE_JPEG, 'photo.jpg');

    expect(res.status).toBe(201);
    expect(res.body.isVerified).toBe(true);
    expect(res.body.listingId).toBe(listing.id);
    expect(res.body.photos.length).toBe(1);
    expect(res.body.title).toBe(VALID_FIELDS.title);
    expect(res.body.recommend).toBe(true);

    const updatedListing = await Listing.findByPk(listing.id);
    expect(Number(updatedListing.ratingAvg)).toBe(5);
    expect(updatedListing.ratingCount).toBe(1);
  });

  test('refuse un second avis pour la meme reservation (409)', async () => {
    const res = await attachFields(
      request(app)
        .post('/api/reviews')
        .set('Authorization', `Bearer ${tokenFor(clientUser)}`)
        .field('bookingId', completedBooking.id)
    );

    expect(res.status).toBe(409);
  });
});

describe('POST /api/reviews (avis public sans reservation)', () => {
  test('refuse un visiteur anonyme sans nom (400)', async () => {
    const res = await attachFields(request(app).post('/api/reviews').field('listingId', listing.id));

    expect(res.status).toBe(400);
  });

  test('refuse un avis public sans listingId (400)', async () => {
    const res = await attachFields(
      request(app).post('/api/reviews').field('guestName', 'Anonyme')
    );

    expect(res.status).toBe(400);
  });

  test('un visiteur anonyme peut publier un avis non verifie avec son nom', async () => {
    const before = await Listing.findByPk(listing.id);

    const res = await attachFields(
      request(app).post('/api/reviews').field('listingId', listing.id).field('guestName', 'Sami Visiteur')
    );

    expect(res.status).toBe(201);
    expect(res.body.isVerified).toBe(false);
    expect(res.body.bookingId).toBeNull();
    expect(res.body.guestName).toBe('Sami Visiteur');
    expect(res.body.listingId).toBe(listing.id);

    const after = await Listing.findByPk(listing.id);
    expect(after.ratingCount).toBe(before.ratingCount + 1);
  });

  test('un client connecte peut publier un avis public non verifie sans reservation', async () => {
    const res = await attachFields(
      request(app)
        .post('/api/reviews')
        .set('Authorization', `Bearer ${tokenFor(otherClientUser)}`)
        .field('listingId', listing.id)
    );

    expect(res.status).toBe(201);
    expect(res.body.isVerified).toBe(false);
    expect(res.body.bookingId).toBeNull();
  });

  test('refuse un avis publie par un prestataire (403)', async () => {
    const res = await attachFields(
      request(app)
        .post('/api/reviews')
        .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
        .field('listingId', listing.id)
    );

    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/reviews/:id/reply', () => {
  test("refuse la reponse d'un prestataire non proprietaire (403)", async () => {
    const review = await Review.findOne({ where: { listingId: listing.id } });

    const res = await request(app)
      .patch(`/api/reviews/${review.id}/reply`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ reply: 'Merci !' });

    expect(res.status).toBe(403);
  });

  test('le prestataire proprietaire peut repondre', async () => {
    const review = await Review.findOne({ where: { listingId: listing.id } });

    const res = await request(app)
      .patch(`/api/reviews/${review.id}/reply`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ reply: 'Merci beaucoup pour votre confiance !' });

    expect(res.status).toBe(200);
    expect(res.body.providerReply).toBe('Merci beaucoup pour votre confiance !');
  });
});

describe('PATCH /api/reviews/:id/verify', () => {
  test("refuse la verification d'un prestataire non proprietaire (403)", async () => {
    const review = await Review.findOne({ where: { listingId: listing.id, isVerified: false } });

    const res = await request(app)
      .patch(`/api/reviews/${review.id}/verify`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);

    expect(res.status).toBe(403);
    const unchanged = await Review.findByPk(review.id);
    expect(unchanged.isVerified).toBe(false);
  });

  test('le prestataire proprietaire peut verifier et confirmer un avis public', async () => {
    const review = await Review.findOne({ where: { listingId: listing.id, isVerified: false } });

    const res = await request(app)
      .patch(`/api/reviews/${review.id}/verify`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.isVerified).toBe(true);

    const updated = await Review.findByPk(review.id);
    expect(updated.isVerified).toBe(true);
  });
});

describe('POST /api/reviews/:id/report', () => {
  test('signale un avis et cree un litige', async () => {
    const review = await Review.findOne({ where: { listingId: listing.id } });

    const res = await request(app)
      .post(`/api/reviews/${review.id}/report`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ type: 'fake_review', description: 'Ce client n\'a jamais reserve.' });

    expect(res.status).toBe(201);

    const updatedReview = await Review.findByPk(review.id);
    expect(updatedReview.isReported).toBe(true);

    const dispute = await Dispute.findOne({ where: { reviewId: review.id } });
    expect(dispute).not.toBeNull();
    expect(dispute.status).toBe('open');
  });
});

describe('GET /api/bookings/me', () => {
  test('renvoie les reservations du client avec son avis le cas echeant', async () => {
    const res = await request(app)
      .get('/api/bookings/me')
      .set('Authorization', `Bearer ${tokenFor(clientUser)}`);

    expect(res.status).toBe(200);
    const completed = res.body.find((b) => b.id === completedBooking.id);
    expect(completed.review).not.toBeNull();
    const pending = res.body.find((b) => b.id === pendingBooking.id);
    expect(pending.review).toBeNull();
  });
});
