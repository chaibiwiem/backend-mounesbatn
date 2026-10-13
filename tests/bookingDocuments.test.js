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

const { Category, User, Listing, Invoice, Contract } = db;

let provider;
let otherProvider;
let otherBookingId;

const tokenFor = (user) => jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });

function dateFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
const fr = (iso) => iso.split('-').reverse().join('/');

async function createBooking(user, body) {
  const res = await request(app).post('/api/bookings').set(auth(user)).send(body);
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });
  const venues = await Category.create({ name: 'Lieux', slug: 'lieux' });
  const halls = await Category.create({ name: 'Salles', slug: 'salles', parentId: venues.id });
  const makeProvider = (email) =>
    User.create({ role: 'provider', firstName: 'P', lastName: 'Docs', email, passwordHash: 'hash', emailVerified: true });
  provider = await makeProvider('docs.provider@example.com');
  otherProvider = await makeProvider('docs.other@example.com');
  await Listing.create({ userId: provider.id, categoryId: halls.id, title: 'Salle Docs', city: 'Tunis', status: 'active' });
  await Listing.create({ userId: otherProvider.id, categoryId: halls.id, title: 'Salle Autre', city: 'Sousse', status: 'active' });
  otherBookingId = (await createBooking(otherProvider, { clientName: 'Autre Client', eventDate: dateFromToday(30) })).id;
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('Date de reservation modifiee -> facture et contrat du client', () => {
  test('facture (description auto + PDF) et contrat brouillon suivent la nouvelle date', async () => {
    const firstDate = dateFromToday(40);
    const booking = await createBooking(provider, {
      clientName: 'Leila Client',
      clientEmail: 'leila.client@example.com',
      eventDate: firstDate,
      totalPrice: 2000,
    });

    const invoice = await request(app)
      .post('/api/invoices')
      .set(auth(provider))
      .send({ bookingId: booking.id, amount: 2000, description: `Prestation — événement du ${fr(firstDate)}` });
    expect(invoice.status).toBe(201);

    const contract = await request(app)
      .post('/api/contracts')
      .set(auth(provider))
      .send({ clientId: booking.clientId, bookingId: booking.id, object: 'Soirée de mariage', amount: 2000 });
    expect(contract.status).toBe(201);
    expect(contract.body.bookingId).toBe(booking.id);

    const newDate = dateFromToday(55);
    const res = await request(app).patch(`/api/bookings/${booking.id}`).set(auth(provider)).send({ eventDate: newDate });
    expect(res.status).toBe(200);
    expect(res.body.documentsUpdated).toEqual({ invoices: 1, contracts: 1 });

    const updatedInvoice = await Invoice.findByPk(invoice.body.id);
    expect(updatedInvoice.description).toBe(`Prestation — événement du ${fr(newDate)}`);
    expect(updatedInvoice.pdfUrl).not.toBe(invoice.body.pdfUrl);

    const updatedContract = await Contract.findByPk(contract.body.id);
    expect(updatedContract.pdfUrl).not.toBe(contract.body.pdfUrl);
  });

  test('description saisie a la main conservee ; contrat signe fige ; sans changement de date rien ne bouge', async () => {
    const booking = await createBooking(provider, { clientName: 'Sami Client', eventDate: dateFromToday(60) });
    const invoice = await request(app)
      .post('/api/invoices')
      .set(auth(provider))
      .send({ bookingId: booking.id, amount: 900, description: 'DJ + sonorisation' });
    const contract = await request(app)
      .post('/api/contracts')
      .set(auth(provider))
      .send({ clientId: booking.clientId, bookingId: booking.id, object: 'Animation DJ' });
    await request(app).patch(`/api/contracts/${contract.body.id}`).set(auth(provider)).send({ status: 'signed' });
    const signedPdf = (await Contract.findByPk(contract.body.id)).pdfUrl;

    const sameDate = await request(app).patch(`/api/bookings/${booking.id}`).set(auth(provider)).send({ notes: 'RAS' });
    expect(sameDate.body.documentsUpdated).toEqual({ invoices: 0, contracts: 0 });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(auth(provider))
      .send({ eventDate: dateFromToday(70) });
    expect(res.body.documentsUpdated).toEqual({ invoices: 1, contracts: 0 });
    expect((await Invoice.findByPk(invoice.body.id)).description).toBe('DJ + sonorisation');
    expect((await Contract.findByPk(contract.body.id)).pdfUrl).toBe(signedPdf);
  });

  test("un contrat ne peut pas etre lie a la reservation d'un autre prestataire (404)", async () => {
    const booking = await createBooking(provider, { clientName: 'Nour Client', eventDate: dateFromToday(80) });
    const res = await request(app)
      .post('/api/contracts')
      .set(auth(provider))
      .send({ clientId: booking.clientId, bookingId: otherBookingId, object: 'Test' });
    expect(res.status).toBe(404);
  });
});
