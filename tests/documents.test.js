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
const { DOCUMENTS_DIR } = require('../src/services/pdfService');

const { Category, User, Listing, Client, Contract, Invoice } = db;

let category;
let providerUser;
let otherProviderUser;
let listing;
let client;
let preExistingDocumentFiles;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  // Snapshot avant les tests : DOCUMENTS_DIR est un dossier partage avec la
  // vraie app en dev (contrats/factures reels) — on ne doit jamais supprimer
  // autre chose que les fichiers generes par CETTE suite de tests.
  preExistingDocumentFiles = fs.existsSync(DOCUMENTS_DIR)
    ? new Set(fs.readdirSync(DOCUMENTS_DIR))
    : new Set();

  category = await Category.create({ name: 'DJ', slug: 'dj-documents-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Mzoughi',
    email: 'provider.docs.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherProviderUser = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Prestataire',
    email: 'other.provider.docs.test@example.com',
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
    email: 'sami.docs.test@example.com',
    phone: '+21620000077',
  });
});

afterAll(async () => {
  await db.sequelize.close();
  if (fs.existsSync(DOCUMENTS_DIR)) {
    fs.readdirSync(DOCUMENTS_DIR)
      .filter((file) => !preExistingDocumentFiles.has(file))
      .forEach((file) => fs.unlinkSync(path.join(DOCUMENTS_DIR, file)));
  }
});

describe('Contrats (POST/PATCH /api/contracts, POST /send)', () => {
  let contractId;

  test('cree un contrat en brouillon avec un PDF genere', async () => {
    const res = await request(app)
      .post('/api/contracts')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientId: client.id,
        object: 'Animation DJ mariage',
        amount: 1500,
        deposit: 300,
        paymentMode: 'cash',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.pdfUrl).toMatch(/^\/uploads\/documents\//);

    const pdfPath = path.join(DOCUMENTS_DIR, path.basename(res.body.pdfUrl));
    expect(fs.existsSync(pdfPath)).toBe(true);

    contractId = res.body.id;
  });

  test("refuse la creation sans objet (400)", async () => {
    const res = await request(app)
      .post('/api/contracts')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id });

    expect(res.status).toBe(400);
  });

  test("un prestataire non proprietaire ne voit pas le contrat (404)", async () => {
    const res = await request(app)
      .patch(`/api/contracts/${contractId}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ amount: 1 });

    expect(res.status).toBe(404);
  });

  test('modifie le montant et regenere le PDF', async () => {
    const res = await request(app)
      .patch(`/api/contracts/${contractId}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ amount: 1800 });

    expect(res.status).toBe(200);
    expect(Number(res.body.amount)).toBe(1800);
  });

  test('rejette un statut invalide (400)', async () => {
    const res = await request(app)
      .patch(`/api/contracts/${contractId}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ status: 'bogus' });

    expect(res.status).toBe(400);
  });

  test("envoie le contrat au client et passe le statut a 'sent'", async () => {
    const res = await request(app)
      .post(`/api/contracts/${contractId}/send`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.contract.status).toBe('sent');

    const contract = await Contract.findByPk(contractId);
    expect(contract.status).toBe('sent');
  });

  test('peut etre marque comme signe', async () => {
    const res = await request(app)
      .patch(`/api/contracts/${contractId}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ status: 'signed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('signed');
  });
});

describe('Factures (POST/PATCH /api/invoices, POST /send)', () => {
  let firstInvoiceNumber;

  test('genere une premiere facture numerotee FAC-<annee>-0001', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id, amount: 1500, taxRate: 19 });

    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^FAC-\d{4}-0001$/);
    expect(res.body.status).toBe('unpaid');
    expect(res.body.pdfUrl).toMatch(/^\/uploads\/documents\//);

    firstInvoiceNumber = res.body.number;
  });

  test('la deuxieme facture incremente le numero de sequence', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id, amount: 500 });

    expect(res.status).toBe(201);
    expect(res.body.number).not.toBe(firstInvoiceNumber);
    expect(res.body.number).toMatch(/^FAC-\d{4}-0002$/);
  });

  test('refuse la creation sans montant (400)', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id });

    expect(res.status).toBe(400);
  });

  test('le taux de TVA est enregistre en % (pas un montant fixe)', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id, amount: 1000, taxRate: 19 });

    expect(res.status).toBe(201);
    expect(Number(res.body.taxRate)).toBe(19);
  });

  test('une facture peut etre emise sans TVA (taxRate omis)', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id, amount: 750 });

    expect(res.status).toBe(201);
    expect(res.body.taxRate).toBeNull();
  });

  test('refuse un taux de TVA hors de la plage 0-100 (400)', async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id, amount: 400, taxRate: 150 });

    expect(res.status).toBe(400);
  });

  test("enregistre l'acompte verse (TTC 1190, acompte 400 => reste 790)", async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id, amount: 1000, taxRate: 19, deposit: 400 });

    expect(res.status).toBe(201);
    expect(Number(res.body.deposit)).toBe(400);
    const { computeInvoiceTotals } = require('../src/utils/invoiceTotals');
    const totals = computeInvoiceTotals(res.body);
    expect(totals.ttc).toBe(1190);
    expect(totals.remaining).toBe(790);
  });

  test("refuse un acompte superieur au total TTC (400)", async () => {
    const res = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id, amount: 500, deposit: 600 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/acompte/i);
  });

  test("refuse une modification qui rendrait l'acompte superieur au TTC (400)", async () => {
    const created = await request(app)
      .post('/api/invoices')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id, amount: 800, deposit: 500 });
    expect(created.status).toBe(201);

    const res = await request(app)
      .patch(`/api/invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ amount: 300 });

    expect(res.status).toBe(400);
  });

  test('marque une facture comme payee', async () => {
    const invoice = await Invoice.findOne({ where: { listingId: listing.id } });

    const res = await request(app)
      .patch(`/api/invoices/${invoice.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ status: 'paid' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
  });

  test("un prestataire non proprietaire ne peut pas changer le statut (404)", async () => {
    const invoice = await Invoice.findOne({ where: { listingId: listing.id } });

    const res = await request(app)
      .patch(`/api/invoices/${invoice.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ status: 'cancelled' });

    expect(res.status).toBe(404);
  });

  test('envoie la facture par email', async () => {
    const invoice = await Invoice.findOne({ where: { listingId: listing.id } });

    const res = await request(app)
      .post(`/api/invoices/${invoice.id}/send`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
  });
});

describe('Acces aux PDF (GET /api/documents/:filename)', () => {
  let pdfUrl;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/contracts')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id, object: 'Contrat acces PDF', amount: 800, paymentMode: 'cash' });
    pdfUrl = res.body.pdfUrl;
  });

  test("le lien public /uploads/documents ne sert plus le PDF (404)", async () => {
    const res = await request(app).get(pdfUrl);
    expect(res.status).toBe(404);
  });

  test('sans connexion : 401', async () => {
    const res = await request(app).get(`/api/documents/${path.basename(pdfUrl)}`);
    expect(res.status).toBe(401);
  });

  test("un autre prestataire ne peut pas telecharger le PDF (403)", async () => {
    const res = await request(app)
      .get(`/api/documents/${path.basename(pdfUrl)}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);
    expect(res.status).toBe(403);
  });

  test('le prestataire proprietaire telecharge son PDF', async () => {
    const res = await request(app)
      .get(`/api/documents/${path.basename(pdfUrl)}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  test('un nom de fichier invalide ou une tentative de traversee renvoie 404', async () => {
    const res = await request(app)
      .get('/api/documents/..%2F..%2F.env')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(res.status).toBe(404);
  });
});
