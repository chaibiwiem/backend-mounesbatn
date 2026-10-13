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

const { Category, User, Listing, Lead, Availability, Booking } = db;

let accommodationListing;
let standardListing;

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

// Chaque test utilise un email distinct : l'anti-spam de createLead refuse
// (429) deux demandes du meme email vers la meme fiche en moins de 10 min.
function leadPayload(overrides = {}) {
  return {
    listingId: accommodationListing.id,
    firstName: 'Sana',
    lastName: 'Voyageuse',
    phone: '+21620123456',
    checkInDate: futureDate(30),
    checkOutDate: futureDate(33),
    rooms: [
      { adults: 2, children: 1, babies: 0 },
      { adults: 2, children: 0, babies: 1 },
    ],
    message: 'Séjour pour le mariage de ma soeur.',
    ...overrides,
  };
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  const venues = await Category.create({ name: 'Lieux de mariage', slug: 'lieux-de-mariage' });
  // Slug reel en base (voir services/accommodationService.js).
  const guesthouses = await Category.create({
    name: "Maisons d'hôtes",
    slug: 'maisons-hotes',
    parentId: venues.id,
  });
  const halls = await Category.create({
    name: 'Salles de fêtes',
    slug: 'salles-de-fetes',
    parentId: venues.id,
  });

  const provider = await User.create({
    role: 'provider',
    firstName: 'Hela',
    lastName: 'Hote',
    email: 'provider.accommodation.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  accommodationListing = await Listing.create({
    userId: provider.id,
    categoryId: guesthouses.id,
    title: 'Dar Jasmin',
    city: 'Hammamet',
    status: 'active',
  });

  standardListing = await Listing.create({
    userId: provider.id,
    categoryId: halls.id,
    title: 'Salle Le Palais',
    city: 'Tunis',
    status: 'active',
  });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('POST /api/leads - sejour "Maison d\'hote"', () => {
  test('enregistre arrivee, depart et chambres (201)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send(leadPayload({ email: 'ok.accommodation@example.com' }));

    expect(res.status).toBe(201);
    expect(res.body.lead.checkInDate).toBe(futureDate(30));
    expect(res.body.lead.checkOutDate).toBe(futureDate(33));
    expect(res.body.lead.rooms).toEqual([
      { adults: 2, children: 1, babies: 0 },
      { adults: 2, children: 0, babies: 1 },
    ]);

    const stored = await Lead.findByPk(res.body.lead.id);
    expect(stored.rooms).toHaveLength(2);
  });

  test('enregistre le nombre d\'invites optionnel, absent = null', async () => {
    const withGuests = await request(app)
      .post('/api/leads')
      .send(
        leadPayload({
          email: 'guests.accommodation@example.com',
          checkInDate: futureDate(90),
          checkOutDate: futureDate(92),
          guests: '100-150',
        })
      );
    expect(withGuests.status).toBe(201);
    expect(withGuests.body.lead.guests).toBe('100-150');

    const withoutGuests = await request(app)
      .post('/api/leads')
      .send(
        leadPayload({
          email: 'no.guests.accommodation@example.com',
          checkInDate: futureDate(95),
          checkOutDate: futureDate(97),
        })
      );
    expect(withoutGuests.status).toBe(201);
    expect(withoutGuests.body.lead.guests ?? null).toBeNull();
  });

  test('refuse un sejour couvrant une nuit bloquee par le prestataire (409)', async () => {
    await Availability.create({
      listingId: accommodationListing.id,
      date: futureDate(41),
      isAvailable: false,
    });

    const res = await request(app)
      .post('/api/leads')
      .send(
        leadPayload({
          email: 'blocked.accommodation@example.com',
          checkInDate: futureDate(40),
          checkOutDate: futureDate(43),
        })
      );

    expect(res.status).toBe(409);
  });

  test('le jour de depart lui-meme peut etre bloque (nuits [arrivee, depart[)', async () => {
    await Availability.create({
      listingId: accommodationListing.id,
      date: futureDate(53),
      isAvailable: false,
    });

    const res = await request(app)
      .post('/api/leads')
      .send(
        leadPayload({
          email: 'checkout.day.accommodation@example.com',
          checkInDate: futureDate(50),
          checkOutDate: futureDate(53),
        })
      );

    expect(res.status).toBe(201);
  });

  test('refuse un sejour chevauchant une reservation confirmee (409)', async () => {
    await Booking.create({
      listingId: accommodationListing.id,
      eventDate: futureDate(61),
      status: 'confirmed',
    });

    const res = await request(app)
      .post('/api/leads')
      .send(
        leadPayload({
          email: 'booked.accommodation@example.com',
          checkInDate: futureDate(60),
          checkOutDate: futureDate(62),
        })
      );

    expect(res.status).toBe(409);
  });

  test('refuse un depart anterieur ou egal a l\'arrivee (400)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send(
        leadPayload({
          email: 'inverted.accommodation@example.com',
          checkInDate: futureDate(70),
          checkOutDate: futureDate(70),
        })
      );

    expect(res.status).toBe(400);
  });

  test('refuse une chambre sans adulte (400)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send(
        leadPayload({
          email: 'no.adult.accommodation@example.com',
          rooms: [{ adults: 0, children: 2, babies: 0 }],
        })
      );

    expect(res.status).toBe(400);
  });

  test('ignore les champs sejour pour une autre sous-categorie de Lieux de mariage', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send(
        leadPayload({
          listingId: standardListing.id,
          email: 'hall.accommodation@example.com',
          eventDate: futureDate(80),
          guests: '100-150',
        })
      );

    expect(res.status).toBe(201);
    expect(res.body.lead.checkInDate).toBeNull();
    expect(res.body.lead.checkOutDate).toBeNull();
    expect(res.body.lead.rooms).toBeNull();
  });
});
