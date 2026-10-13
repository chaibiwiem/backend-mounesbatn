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

const { Category, User, Listing, Lead, Booking, Client } = db;

let provider;
let otherProvider;
let listing;
let otherListing;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

const ROOMS = [
  { adults: 2, children: 1, babies: 0 },
  { adults: 2, children: 0, babies: 1 },
];

async function createStayLead(email, checkIn, checkOut) {
  const res = await request(app).post('/api/leads').send({
    listingId: listing.id,
    firstName: 'Sana',
    lastName: 'Voyageuse',
    email,
    phone: '+21620123456',
    checkInDate: checkIn,
    checkOutDate: checkOut,
    rooms: ROOMS,
    guests: '100-150',
  });
  expect(res.status).toBe(201);
  return res.body.lead;
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  const venues = await Category.create({ name: 'Lieux de mariage', slug: 'lieux-de-mariage' });
  const guesthouses = await Category.create({ name: "Maisons d'hôtes", slug: 'maisons-hotes', parentId: venues.id });

  provider = await User.create({
    role: 'provider',
    firstName: 'Hela',
    lastName: 'Hote',
    email: 'provider.staybookings.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });
  otherProvider = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Hote',
    email: 'other.staybookings.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  listing = await Listing.create({
    userId: provider.id,
    categoryId: guesthouses.id,
    title: 'Dar Jasmin',
    city: 'Hammamet',
    status: 'active',
  });
  otherListing = await Listing.create({
    userId: otherProvider.id,
    categoryId: guesthouses.id,
    title: 'Dar Autre',
    city: 'Sousse',
    status: 'active',
  });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('Reservation issue d\'une demande de sejour', () => {
  let booking;

  test('recopie arrivee, depart, chambres et invites de la demande', async () => {
    const lead = await createStayLead('booking.from.lead@example.com', futureDate(20), futureDate(23));

    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ leadId: lead.id, totalPrice: 900 });

    expect(res.status).toBe(201);
    booking = await Booking.findByPk(res.body.id);
    expect(booking.checkInDate).toBe(futureDate(20));
    expect(booking.checkOutDate).toBe(futureDate(23));
    expect(booking.eventDate).toBe(futureDate(20));
    expect(booking.rooms).toEqual(ROOMS);
    expect(booking.guests).toBe('100-150');
  });

  test('le calendrier public bloque chaque nuit du sejour, pas le jour de depart', async () => {
    const res = await request(app).get(`/api/listings/${listing.id}/availability`);
    const blocked = res.body.filter((e) => e.isAvailable === false).map((e) => e.date);
    expect(blocked).toEqual(expect.arrayContaining([futureDate(20), futureDate(21), futureDate(22)]));
    expect(blocked).not.toContain(futureDate(23));
  });

  test('une nouvelle demande chevauchant une nuit du sejour reserve est refusee (409)', async () => {
    const res = await request(app).post('/api/leads').send({
      listingId: listing.id,
      firstName: 'Autre',
      lastName: 'Client',
      email: 'overlap.stay@example.com',
      phone: '+21620123457',
      checkInDate: futureDate(22),
      checkOutDate: futureDate(25),
      rooms: [{ adults: 2 }],
    });
    expect(res.status).toBe(409);
  });

  test('la fiche client (CRM) renvoie l\'historique avec le detail du sejour', async () => {
    const res = await request(app)
      .get(`/api/clients/${booking.clientId}`)
      .set('Authorization', `Bearer ${tokenFor(provider)}`);
    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].checkInDate).toBe(futureDate(20));
    expect(res.body.bookings[0].rooms).toEqual(ROOMS);
  });

  test('facture liee a la reservation : client repris de la reservation', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ bookingId: booking.id, amount: 900, description: 'Séjour Dar Jasmin' });
    expect(res.status).toBe(201);
    expect(Number(res.body.bookingId)).toBe(Number(booking.id));
    expect(Number(res.body.clientId)).toBe(Number(booking.clientId));
    expect(res.body.pdfUrl).toBeTruthy();
  });

  test('refuse de lier une facture a la reservation d\'un autre prestataire (404)', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(otherProvider)}`)
      .send({ bookingId: booking.id, amount: 100 });
    expect(res.status).toBe(404);
  });
});

describe('Autres chemins de creation de reservation', () => {
  test('reservation saisie sans demande, avec sejour', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({
        clientName: 'Client Direct',
        checkInDate: futureDate(40),
        checkOutDate: futureDate(42),
        rooms: [{ adults: 1, children: 0, babies: 0 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.checkInDate).toBe(futureDate(40));
    expect(res.body.eventDate).toBe(futureDate(40));
  });

  test('refuse un depart anterieur a l\'arrivee (400)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ clientName: 'Client Direct', checkInDate: futureDate(50), checkOutDate: futureDate(49) });
    expect(res.status).toBe(400);
  });

  test('passer la demande en "convertie" cree une reservation avec le sejour', async () => {
    const lead = await createStayLead('converted.stay@example.com', futureDate(60), futureDate(62));
    const res = await request(app)
      .patch(`/api/leads/${lead.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ status: 'converted' });
    expect(res.status).toBe(200);

    const booking = await Booking.findOne({ where: { leadId: lead.id } });
    expect(booking.checkInDate).toBe(futureDate(60));
    expect(booking.checkOutDate).toBe(futureDate(62));
    expect(booking.eventDate).toBe(futureDate(60));
    expect(booking.rooms).toEqual(ROOMS);
  });
});

describe('Prix des chambres, remise et calcul automatique du total', () => {
  test('total = prix des chambres x nuits - remise en DT (montant envoye ignore)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({
        clientName: 'Client Tarif',
        checkInDate: futureDate(120),
        checkOutDate: futureDate(124),
        rooms: [
          { adults: 2, price: 150 },
          { adults: 1, price: 100 },
        ],
        discountType: 'amount',
        discountValue: 50,
        totalPrice: 1,
      });

    expect(res.status).toBe(201);
    const booking = await Booking.findByPk(res.body.id);
    // (150 + 100) x 4 nuits - 50
    expect(Number(booking.totalPrice)).toBe(950);
    expect(booking.rooms[0].price).toBe(150);
    expect(booking.discountType).toBe('amount');
    expect(Number(booking.discountValue)).toBe(50);
  });

  test('modification : total recalcule avec une remise en pourcentage', async () => {
    const created = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({
        clientName: 'Client Pourcentage',
        checkInDate: futureDate(130),
        checkOutDate: futureDate(132),
        rooms: [{ adults: 2, price: 200 }],
      });
    expect(created.status).toBe(201);
    expect(Number((await Booking.findByPk(created.body.id)).totalPrice)).toBe(400);

    const res = await request(app)
      .patch(`/api/bookings/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ checkOutDate: futureDate(133), discountType: 'percent', discountValue: 10 });
    expect(res.status).toBe(200);
    // 200 x 3 nuits = 600, -10 % = 540
    expect(Number((await Booking.findByPk(created.body.id)).totalPrice)).toBe(540);
  });

  test('sans prix de chambre : montant saisi conserve et remise ignoree', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({
        clientName: 'Client Manuel',
        checkInDate: futureDate(140),
        checkOutDate: futureDate(142),
        rooms: [{ adults: 2 }],
        totalPrice: 333,
        discountType: 'amount',
        discountValue: 20,
      });
    expect(res.status).toBe(201);
    const booking = await Booking.findByPk(res.body.id);
    expect(Number(booking.totalPrice)).toBe(333);
    expect(booking.discountValue).toBeNull();
  });

  test('refuse une remise superieure a 100 % (400)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({
        clientName: 'Client Excessif',
        checkInDate: futureDate(150),
        checkOutDate: futureDate(151),
        rooms: [{ adults: 2, price: 100 }],
        discountType: 'percent',
        discountValue: 120,
      });
    expect(res.status).toBe(400);
  });
});
