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

const { Category, User, Listing, Package, Booking, Subscription } = db;

let provider;
let listing;
let otherListing;
let soiree;
let reception;
let otherPack;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function createLead(email, extra = {}) {
  const res = await request(app)
    .post('/api/leads')
    .send({
      listingId: listing.id,
      firstName: 'Rim',
      lastName: 'Cliente',
      email,
      phone: '+21620123456',
      eventDate: futureDate(30),
      guests: '100-150',
      ...extra,
    });
  return res;
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  const animation = await Category.create({ name: 'Animation', slug: 'animation' });
  const dj = await Category.create({ name: 'DJ', slug: 'dj', parentId: animation.id });

  provider = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Dj',
    email: 'provider.packbookings.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });
  const otherProvider = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Dj',
    email: 'other.packbookings.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });
  // Abonnement actif : la conversion d'une demande (PATCH status) est
  // reservee a un prestataire non expire.
  await Subscription.create({
    userId: provider.id,
    plan: 'pro',
    status: 'active',
    startDate: futureDate(-1),
    endDate: futureDate(60),
  });

  listing = await Listing.create({
    userId: provider.id,
    categoryId: dj.id,
    title: 'DJ Karim',
    city: 'Tunis',
    status: 'active',
  });
  otherListing = await Listing.create({
    userId: otherProvider.id,
    categoryId: dj.id,
    title: 'DJ Autre',
    city: 'Sousse',
    status: 'active',
  });

  soiree = await Package.create({ listingId: listing.id, name: 'Pack soirée', price: 400, priceType: 'fixed' });
  reception = await Package.create({ listingId: listing.id, name: 'Pack réception', price: 300, priceType: 'fixed' });
  otherPack = await Package.create({ listingId: otherListing.id, name: 'Pack autre', price: 100, priceType: 'fixed' });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('Pack choisi sur une demande (toutes categories)', () => {
  test('conserve le pack coche pour une fiche standard', async () => {
    const res = await createLead('pack.lead@example.com', { packageId: soiree.id });
    expect(res.status).toBe(201);
    expect(res.body.lead.packageId).toBe(soiree.id);
  });

  test("refuse un pack d'une autre fiche (400)", async () => {
    const res = await createLead('pack.other@example.com', { packageId: otherPack.id });
    expect(res.status).toBe(400);
  });

  test('le prestataire voit le nom et le prix du pack dans ses demandes', async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/leads`)
      .set('Authorization', `Bearer ${tokenFor(provider)}`);
    expect(res.status).toBe(200);
    const found = res.body.leads.find((lead) => lead.email === 'pack.lead@example.com');
    expect(found.package.name).toBe('Pack soirée');
    expect(Number(found.package.price)).toBe(400);
  });
});

describe('Pack sur une reservation', () => {
  test('une reservation issue de la demande reprend son pack', async () => {
    const lead = await createLead('pack.booking@example.com', { packageId: soiree.id });
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ leadId: lead.body.lead.id, totalPrice: 400 });
    expect(res.status).toBe(201);
    expect(res.body.package.name).toBe('Pack soirée');

    const list = await request(app)
      .get(`/api/listings/${listing.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(provider)}`);
    const found = list.body.find((b) => b.id === res.body.id);
    expect(found.package.name).toBe('Pack soirée');
    expect(Number(found.package.price)).toBe(400);
  });

  test('reservation manuelle avec pack, puis changement et retrait du pack', async () => {
    const created = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ clientName: 'Client Direct', eventDate: futureDate(40), packageId: reception.id });
    expect(created.status).toBe(201);
    expect(created.body.packageId).toBe(reception.id);

    const changed = await request(app)
      .patch(`/api/bookings/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ packageId: soiree.id });
    expect(changed.status).toBe(200);
    expect((await Booking.findByPk(created.body.id)).packageId).toBe(soiree.id);

    const cleared = await request(app)
      .patch(`/api/bookings/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ packageId: null });
    expect(cleared.status).toBe(200);
    expect((await Booking.findByPk(created.body.id)).packageId).toBeNull();
  });

  test("refuse le pack d'une autre fiche sur une reservation (400)", async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ clientName: 'Client Pirate', eventDate: futureDate(41), packageId: otherPack.id });
    expect(res.status).toBe(400);
  });

  test('une demande passee "convertie" cree une reservation avec son pack', async () => {
    const lead = await createLead('pack.converted@example.com', { packageId: reception.id });
    const res = await request(app)
      .patch(`/api/leads/${lead.body.lead.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ status: 'converted' });
    expect(res.status).toBe(200);
    const booking = await Booking.findOne({ where: { leadId: lead.body.lead.id } });
    expect(booking.packageId).toBe(reception.id);
  });
});

describe('Sejour avec pack : le prix du pack entre dans le total calcule', () => {
  test('chambres x nuits + pack - remise', async () => {
    const guesthouses = await Category.create({ name: "Maisons d'hôtes", slug: 'maisons-hotes' });
    await listing.update({ categoryId: guesthouses.id });
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({
        clientName: 'Client Sejour Pack',
        checkInDate: futureDate(90),
        checkOutDate: futureDate(92),
        rooms: [{ adults: 2, price: 100 }],
        packageId: soiree.id,
        discountType: 'amount',
        discountValue: 100,
      });
    expect(res.status).toBe(201);
    // 100 x 2 nuits + 400 (pack) - 100
    expect(Number((await Booking.findByPk(res.body.id)).totalPrice)).toBe(500);
  });
});

describe('Remise et calcul automatique - categorie standard (hors sejour)', () => {
  test('prix de la prestation + pack - remise en pourcentage', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({
        clientName: 'Client Mariage',
        eventDate: futureDate(70),
        servicePrice: 600,
        packageId: reception.id,
        discountType: 'percent',
        discountValue: 10,
        totalPrice: 1,
      });
    expect(res.status).toBe(201);
    const booking = await Booking.findByPk(res.body.id);
    // (600 + 300) - 10 % = 810
    expect(Number(booking.totalPrice)).toBe(810);
    expect(Number(booking.servicePrice)).toBe(600);
    expect(booking.discountType).toBe('percent');
  });

  test('modification : nouveau prix et remise en DT, total recalcule', async () => {
    const created = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ clientName: 'Client Anniv', eventDate: futureDate(71), servicePrice: 500 });
    expect(created.status).toBe(201);
    expect(Number((await Booking.findByPk(created.body.id)).totalPrice)).toBe(500);

    const res = await request(app)
      .patch(`/api/bookings/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ servicePrice: 700, discountType: 'amount', discountValue: 50 });
    expect(res.status).toBe(200);
    expect(Number((await Booking.findByPk(created.body.id)).totalPrice)).toBe(650);
  });

  test('sans prix ni pack : montant manuel conserve, remise ignoree', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ clientName: 'Client Libre', eventDate: futureDate(72), totalPrice: 1234, discountValue: 100 });
    expect(res.status).toBe(201);
    const booking = await Booking.findByPk(res.body.id);
    expect(Number(booking.totalPrice)).toBe(1234);
    expect(booking.discountValue).toBeNull();
  });

  test('la remise ne depasse jamais le sous-total (total minimum 0)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(provider)}`)
      .send({ clientName: 'Client Remise', eventDate: futureDate(73), servicePrice: 100, discountValue: 500 });
    expect(res.status).toBe(201);
    expect(Number((await Booking.findByPk(res.body.id)).totalPrice)).toBe(0);
  });
});
