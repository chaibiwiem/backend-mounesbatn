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

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  category = await Category.create({ name: 'DJ', slug: 'dj-security-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Mzoughi',
    email: 'provider.security.test@example.com',
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
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('Nettoyage des entrees (sanitize-html)', () => {
  test('une description contenant <script>alert(1)</script> est stockee sans balise', async () => {
    const res = await request(app)
      .patch('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ description: 'Super prestataire <script>alert(1)</script> à Tunis' });

    expect(res.status).toBe(200);
    expect(res.body.description).not.toMatch(/<script/i);
    expect(res.body.description).not.toMatch(/alert\(1\)/);
    // sanitize-html retire la balise mais garde le texte environnant.
    expect(res.body.description).toContain('Super prestataire');
    expect(res.body.description).toContain('à Tunis');
  });

  test('un nom de prestataire (title) contenant une balise HTML est nettoye', async () => {
    const res = await request(app)
      .patch('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ title: '<img src=x onerror=alert(1)>DJ Karim' });

    expect(res.status).toBe(200);
    expect(res.body.title).not.toMatch(/<img/i);
    expect(res.body.title).not.toMatch(/onerror/i);
    expect(res.body.title).toContain('DJ Karim');
  });

  test("le prenom/nom d'un compte client est nettoye des balises HTML a l'inscription", async () => {
    const res = await request(app).post('/api/auth/register').send({
      firstName: '<script>alert(1)</script>Amina',
      lastName: 'Client',
      email: 'amina.security.test@example.com',
      password: 'motdepasse123',
    });

    expect(res.status).toBe(201);

    const created = await User.findOne({ where: { email: 'amina.security.test@example.com' } });
    expect(created.firstName).not.toMatch(/<script/i);
    expect(created.firstName).toContain('Amina');
  });
});

describe('En-tetes de securite (helmet)', () => {
  test('les en-tetes de securite sont presents dans la reponse', async () => {
    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  test('la carte (tuiles OpenStreetMap) et les polices (Google Fonts) restent chargeables : CSP non bloquante', async () => {
    const res = await request(app).get('/api/categories');
    const csp = res.headers['content-security-policy'];

    expect(csp).toBeDefined();
    // img-src doit autoriser les tuiles de la carte Leaflet (fiches prestataires).
    expect(csp).toMatch(/img-src[^;]*https:\/\/\*\.tile\.openstreetmap\.org/);
    // style-src/font-src doivent autoriser Google Fonts (Playfair Display).
    expect(csp).toMatch(/style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    expect(csp).toMatch(/font-src[^;]*https:\/\/fonts\.gstatic\.com/);
  });
});

describe('Liens externes de la fiche (XSS via href)', () => {
  test('un lien "javascript:" est refuse (400) et non enregistre', async () => {
    const res = await request(app)
      .patch('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ facebookUrl: 'javascript:alert(document.cookie)' });

    expect(res.status).toBe(400);
    await listing.reload();
    expect(listing.facebookUrl).not.toBe('javascript:alert(document.cookie)');
  });

  test('un lien "data:" est refuse (400)', async () => {
    const res = await request(app)
      .patch('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ website: 'data:text/html,<script>alert(1)</script>' });

    expect(res.status).toBe(400);
  });

  test('les liens https:// et les adresses sans schema restent acceptes', async () => {
    const res = await request(app)
      .patch('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ instagramUrl: 'https://www.instagram.com/djkarim/', website: 'www.djkarim.tn' });

    expect(res.status).toBe(200);
    expect(res.body.instagramUrl).toBe('https://www.instagram.com/djkarim/');
    expect(res.body.website).toBe('www.djkarim.tn');
  });
});

describe('Echappement HTML des emails', () => {
  test('les champs saisis par le client sont echappes dans le HTML envoye au prestataire', async () => {
    // Module rechargé isolément pour que le transporteur SMTP (cree au
    // chargement) soit remplace par un faux qui capture le message.
    const sent = [];
    let spy;
    let emailService;
    jest.isolateModules(() => {
      const nodemailer = require('nodemailer');
      spy = jest
        .spyOn(nodemailer, 'createTransport')
        .mockReturnValue({ sendMail: async (msg) => sent.push(msg) });
      emailService = require('../src/services/emailService');
    });
    await emailService.sendNewLeadEmail(
      providerUser,
      {
        firstName: '<a href="https://phishing.example">Cliquez</a>',
        lastName: 'Ben Ali',
        email: 'client@example.com',
        phone: '+21620123456',
        message: '<img src=x onerror=alert(1)>',
        eventDate: '2026-12-01',
      },
      listing
    );
    spy.mockRestore();

    expect(sent).toHaveLength(1);
    expect(sent[0].html).not.toContain('<a href="https://phishing.example">');
    expect(sent[0].html).not.toContain('<img src=x');
    expect(sent[0].html).toContain('&lt;a href=&quot;https://phishing.example&quot;&gt;');
  });
});

describe('Types des champs telephone / email / port', () => {
  test('telephone de la fiche : lettres refusees (400), numero avec espaces accepte et normalise', async () => {
    const bad = await request(app)
      .patch('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ phone: 'appelez-moi' });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .patch('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ phone: '+216 20 123 456' });
    expect(ok.status).toBe(200);
    expect(ok.body.phone).toBe('+21620123456');
  });

  test("reglages email du prestataire : adresse d'expedition et port invalides refuses (400)", async () => {
    const badEmail = await request(app)
      .patch('/api/listings/me/email-settings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ fromEmail: 'pas-un-email' });
    expect(badEmail.status).toBe(400);

    const badPort = await request(app)
      .patch('/api/listings/me/email-settings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ port: 'abc' });
    expect(badPort.status).toBe(400);
  });
});
