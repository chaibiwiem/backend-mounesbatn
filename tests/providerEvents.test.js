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

const { Category, User, Listing, ProviderEvent, Subscription } = db;

const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)]);
const FAKE_TEXT = Buffer.from('pas une image');

let category;
let providerUser;
let otherProviderUser;
let listing;
let otherListing;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function futureDateStr(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function pastDateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  category = await Category.create({ name: 'Traiteur', slug: 'traiteur-events-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Sonia',
    lastName: 'Ben Ali',
    email: 'provider.events.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherProviderUser = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Prestataire',
    email: 'other.provider.events.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  listing = await Listing.create({
    userId: providerUser.id,
    categoryId: category.id,
    title: 'Traiteur Sonia',
    city: 'Tunis',
    address: '12 Avenue Habib Bourguiba',
    status: 'active',
  });

  otherListing = await Listing.create({
    userId: otherProviderUser.id,
    categoryId: category.id,
    title: 'Autre Traiteur',
    city: 'Sousse',
    status: 'active',
  });

  // Plan Pro (eventsEnabled: true, cf. planService.PLAN_CATALOG) : sans
  // abonnement, providerUser retomberait sur Starter (eventsEnabled: false,
  // voir "eventsEnabled" plus bas) et bloquerait a tort les creations testees
  // ici. otherProviderUser reste volontairement sans abonnement (Starter par
  // defaut) pour tester ce blocage.
  await Subscription.create({
    userId: providerUser.id,
    plan: 'pro',
    price: 59,
    billingCycle: 'monthly',
    status: 'active',
    startDate: new Date().toISOString().slice(0, 10),
  });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('POST /api/listings/:id/events', () => {
  test('refuse la creation pour un plan sans eventsEnabled (Starter, 403)', async () => {
    const res = await request(app)
      .post(`/api/listings/${otherListing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .field('title', 'Dégustation')
      .field('eventDate', futureDateStr(10));

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Starter/);
  });

  test('refuse la creation par un non-proprietaire (403)', async () => {
    const res = await request(app)
      .post(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .field('title', 'Journée portes ouvertes')
      .field('eventDate', futureDateStr(10));

    expect(res.status).toBe(403);
  });

  test('refuse un titre manquant (400)', async () => {
    const res = await request(app)
      .post(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('eventDate', futureDateStr(10));

    expect(res.status).toBe(400);
  });

  test('refuse une date manquante (400)', async () => {
    const res = await request(app)
      .post(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('title', 'Show cooking de printemps');

    expect(res.status).toBe(400);
  });

  test('refuse une date deja passee (400)', async () => {
    const res = await request(app)
      .post(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('title', 'Dégustation')
      .field('eventDate', pastDateStr(5));

    expect(res.status).toBe(400);
  });

  test("refuse une heure de fin anterieure ou egale a l'heure de debut (400)", async () => {
    const res = await request(app)
      .post(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('title', 'Défilé de mode')
      .field('eventDate', futureDateStr(15))
      .field('startTime', '18:00')
      .field('endTime', '17:00');

    expect(res.status).toBe(400);
  });

  test('cree un evenement en brouillon avec photo, lieu par defaut = adresse du listing (201)', async () => {
    const res = await request(app)
      .post(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('title', 'Journée portes ouvertes')
      .field('type', 'portes_ouvertes')
      .field('description', 'Venez découvrir nos services')
      .field('eventDate', futureDateStr(20))
      .field('startTime', '09:00')
      .field('endTime', '18:00')
      .attach('image', FAKE_JPEG, 'event.jpg');

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Journée portes ouvertes');
    expect(res.body.type).toBe('portes_ouvertes');
    expect(res.body.isPublished).toBe(false);
    expect(res.body.location).toBe('12 Avenue Habib Bourguiba');
    expect(res.body.imageUrl).toMatch(/^\/uploads\/listings\//);
  });

  test('publie directement un evenement avec un lieu personnalise (201)', async () => {
    const res = await request(app)
      .post(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('title', 'Show cooking')
      .field('type', 'show_cooking')
      .field('eventDate', futureDateStr(7))
      .field('location', 'Hôtel Laico, Tunis')
      .field('isPublished', 'true');

    expect(res.status).toBe(201);
    expect(res.body.isPublished).toBe(true);
    expect(res.body.location).toBe('Hôtel Laico, Tunis');
  });

  test('rejette une photo invalide (magic bytes) avec 400', async () => {
    const res = await request(app)
      .post(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('title', 'Lancement produit')
      .field('eventDate', futureDateStr(30))
      .attach('image', FAKE_TEXT, 'fake.jpg');

    expect(res.status).toBe(400);
  });
});

describe('GET /api/listings/:id/events (espace prestataire)', () => {
  let pastEvent;
  let futureEvent;

  beforeAll(async () => {
    pastEvent = await ProviderEvent.create({
      listingId: listing.id,
      title: 'Ancien événement',
      eventDate: pastDateStr(30),
      isPublished: true,
    });
    futureEvent = await ProviderEvent.create({
      listingId: listing.id,
      title: 'Prochain événement',
      eventDate: futureDateStr(40),
      isPublished: false,
    });
  });

  test("refuse l'acces a un non-proprietaire (403)", async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);

    expect(res.status).toBe(403);
  });

  test('liste tous les evenements (passes + a venir, publies + brouillons)', async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([pastEvent.id, futureEvent.id]));
  });
});

describe('GET /api/listings/:id/events/public', () => {
  let publishedUpcoming;
  let draftUpcoming;
  let publishedPast;

  beforeAll(async () => {
    publishedUpcoming = await ProviderEvent.create({
      listingId: otherListing.id,
      title: 'Dégustation publique à venir',
      eventDate: futureDateStr(5),
      isPublished: true,
    });
    draftUpcoming = await ProviderEvent.create({
      listingId: otherListing.id,
      title: 'Brouillon à venir',
      eventDate: futureDateStr(6),
      isPublished: false,
    });
    publishedPast = await ProviderEvent.create({
      listingId: otherListing.id,
      title: 'Événement publié mais passé',
      eventDate: pastDateStr(2),
      isPublished: true,
    });
  });

  test('ne renvoie que les evenements publies et a venir, sans authentification', async () => {
    const res = await request(app).get(`/api/listings/${otherListing.id}/events/public`);

    expect(res.status).toBe(200);
    const ids = res.body.map((e) => e.id);
    expect(ids).toContain(publishedUpcoming.id);
    expect(ids).not.toContain(draftUpcoming.id);
    expect(ids).not.toContain(publishedPast.id);
  });
});

describe('PATCH /api/events/:id', () => {
  let event;

  beforeEach(async () => {
    event = await ProviderEvent.create({
      listingId: listing.id,
      title: 'Événement à modifier',
      eventDate: futureDateStr(12),
      startTime: '10:00',
      endTime: '12:00',
      isPublished: false,
    });
  });

  test('refuse la modification par un non-proprietaire (403)', async () => {
    const res = await request(app)
      .patch(`/api/events/${event.id}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ title: 'Piraté' });

    expect(res.status).toBe(403);
  });

  test('modifie titre, description et horaires', async () => {
    const res = await request(app)
      .patch(`/api/events/${event.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ title: 'Nouveau titre', description: 'Nouvelle description', startTime: '14:00', endTime: '16:00' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Nouveau titre');
    expect(res.body.description).toBe('Nouvelle description');
  });

  test("refuse une heure de fin anterieure ou egale a l'heure de debut (400)", async () => {
    const res = await request(app)
      .patch(`/api/events/${event.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ startTime: '15:00', endTime: '14:00' });

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/events/:id/publish', () => {
  test('bascule le statut publie (toggle)', async () => {
    const event = await ProviderEvent.create({
      listingId: listing.id,
      title: 'À publier',
      eventDate: futureDateStr(8),
      isPublished: false,
    });

    const res = await request(app)
      .patch(`/api/events/${event.id}/publish`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.isPublished).toBe(true);
  });

  test('accepte un statut explicite', async () => {
    const event = await ProviderEvent.create({
      listingId: listing.id,
      title: 'À dépublier',
      eventDate: futureDateStr(9),
      isPublished: true,
    });

    const res = await request(app)
      .patch(`/api/events/${event.id}/publish`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ isPublished: false });

    expect(res.status).toBe(200);
    expect(res.body.isPublished).toBe(false);
  });
});

describe('DELETE /api/events/:id', () => {
  test('retire un evenement (soft delete) - disparait des listes prestataire et publique', async () => {
    const event = await ProviderEvent.create({
      listingId: listing.id,
      title: 'À supprimer',
      eventDate: futureDateStr(3),
      isPublished: true,
    });

    const res = await request(app)
      .delete(`/api/events/${event.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);

    const ownerList = await request(app)
      .get(`/api/listings/${listing.id}/events`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(ownerList.body.map((e) => e.id)).not.toContain(event.id);

    const publicList = await request(app).get(`/api/listings/${listing.id}/events/public`);
    expect(publicList.body.map((e) => e.id)).not.toContain(event.id);

    const stillInDb = await ProviderEvent.findByPk(event.id, { paranoid: false });
    expect(stillInDb).not.toBeNull();
    expect(stillInDb.deletedAt).not.toBeNull();
  });
});
