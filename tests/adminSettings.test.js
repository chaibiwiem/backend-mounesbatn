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
process.env.ENCRYPTION_KEY = 'test_encryption_key_for_admin_settings_suite';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/models');
const app = require('../src/app');
const { PLAN_CATALOG } = require('../src/services/planService');

const { User } = db;

let superAdminUser;
let moderatorUser;

function tokenFor(user) {
  return jwt.sign(
    { id: user.id, role: user.role, adminRole: user.adminRole || null },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  superAdminUser = await User.create({
    role: 'admin',
    adminRole: 'super_admin',
    firstName: 'Super',
    lastName: 'Admin',
    email: 'super.admin.settings.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  moderatorUser = await User.create({
    role: 'admin',
    adminRole: 'moderator',
    firstName: 'Modo',
    lastName: 'Mounesba',
    email: 'moderator.settings.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  for (const [key, plan] of Object.entries(PLAN_CATALOG)) {
    await db.Plan.create({
      key,
      label: plan.label,
      description: plan.description || '',
      price: plan.price,
      priceYearly: plan.priceYearly,
      maxPhotos: plan.maxPhotos === Infinity ? null : plan.maxPhotos,
      maxVideos: plan.maxVideos === Infinity ? null : plan.maxVideos,
      maxPromotions: plan.maxPromotions === Infinity ? null : plan.maxPromotions,
      featured: plan.featured,
      eventsEnabled: plan.eventsEnabled,
      calendarEnabled: plan.calendarEnabled,
      maxVehicles: plan.maxVehicles === Infinity ? null : plan.maxVehicles,
      maxCategories: plan.maxCategories === Infinity ? null : plan.maxCategories,
    });
  }
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('GET/PATCH /api/admin/plans (Plans & Tarifs)', () => {
  test('liste les 4 plans avec description', async () => {
    const res = await request(app)
      .get('/api/admin/plans')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    const pro = res.body.find((p) => p.key === 'pro');
    expect(pro.price).toBe(59);
    expect(typeof pro.description).toBe('string');
  });

  test('refuse la modification a un moderateur (403)', async () => {
    const res = await request(app)
      .patch('/api/admin/plans/pro')
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`)
      .send({ price: 79 });

    expect(res.status).toBe(403);
  });

  test('refuse un plan inconnu (404)', async () => {
    const res = await request(app)
      .patch('/api/admin/plans/inexistant')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`)
      .send({ price: 10 });

    expect(res.status).toBe(404);
  });

  test('modifie le prix et la description, et repercute sur PLAN_CATALOG', async () => {
    const res = await request(app)
      .patch('/api/admin/plans/pro')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`)
      .send({ price: 79, description: 'Nouvelle description Pro.' });

    expect(res.status).toBe(200);
    expect(res.body.price).toBe(79);
    expect(res.body.description).toBe('Nouvelle description Pro.');

    // La source de verite synchrone (pdfService, subscriptionController...)
    // doit refleter le changement immediatement, sans redemarrage.
    expect(PLAN_CATALOG.pro.price).toBe(79);
    expect(PLAN_CATALOG.pro.description).toBe('Nouvelle description Pro.');
  });

  test('maxPromotions null est accepte et prevaut comme illimite', async () => {
    const res = await request(app)
      .patch('/api/admin/plans/premium')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`)
      .send({ maxPromotions: null });

    expect(res.status).toBe(200);
    expect(res.body.maxPromotions).toBeNull();
    expect(PLAN_CATALOG.premium.maxPromotions).toBe(Infinity);
  });
});

describe('GET/PATCH/POST /api/admin/settings/email (Email SMTP plateforme)', () => {
  // 127.0.0.1:1 (comme le SMTP_HOST/PORT d'environnement de ce fichier) :
  // echoue immediatement (ECONNREFUSED), contrairement a un domaine
  // inexistant dont la resolution DNS peut trainer et faire depasser le
  // timeout Jest - et la configuration plateforme persistant entre tests
  // (cache module-level, cf. emailService), un hote lent contaminerait aussi
  // les envois du describe "Mon profil" plus bas.
  afterAll(async () => {
    await request(app)
      .patch('/api/admin/settings/email')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`)
      .send({ provider: null, pass: '', apiKey: '' });
  });

  test('refuse a un moderateur (403)', async () => {
    const res = await request(app)
      .get('/api/admin/settings/email')
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`);

    expect(res.status).toBe(403);
  });

  test('renvoie une config vide par defaut, sans secret', async () => {
    const res = await request(app)
      .get('/api/admin/settings/email')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.provider).toBeNull();
    expect(res.body.hasPassword).toBe(false);
    expect(res.body.hasApiKey).toBe(false);
  });

  test('enregistre une config SMTP et ne renvoie jamais le mot de passe en clair', async () => {
    const res = await request(app)
      .patch('/api/admin/settings/email')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`)
      .send({
        provider: 'smtp',
        host: '127.0.0.1',
        port: '1',
        user: 'contact@mounesba.tn',
        fromEmail: 'contact@mounesba.tn',
        pass: 'super-secret-password',
      });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('smtp');
    expect(res.body.host).toBe('127.0.0.1');
    expect(res.body.hasPassword).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-password');

    const row = await db.PlatformSetting.findOne();
    expect(row.emailPassEncrypted).not.toBe('super-secret-password');
    expect(row.emailPassEncrypted).not.toBeNull();
  });

  test('refuse un fournisseur invalide (400)', async () => {
    const res = await request(app)
      .patch('/api/admin/settings/email')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`)
      .send({ provider: 'carrier-pigeon' });

    expect(res.status).toBe(400);
  });

  test("l'email de test remonte un echec explicite (SMTP factice injoignable)", async () => {
    const res = await request(app)
      .post('/api/admin/settings/email/test')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`)
      .send({ to: 'test@example.com' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Échec de l'envoi/);
  });
});

describe('PATCH /api/auth/me (Mon profil)', () => {
  test('met a jour le nom sans toucher a la verification email', async () => {
    const res = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`)
      .send({ firstName: 'Super2' });

    expect(res.status).toBe(200);
    expect(res.body.user.firstName).toBe('Super2');
    expect(res.body.user.emailVerified).toBe(true);
  });

  test("changer l'email force une nouvelle verification", async () => {
    const res = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${tokenFor(superAdminUser)}`)
      .send({ email: 'super.admin.settings.new@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('super.admin.settings.new@example.com');
    expect(res.body.user.emailVerified).toBe(false);
  });

  test('refuse un email deja utilise par un autre compte (409)', async () => {
    const res = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`)
      .send({ email: 'super.admin.settings.new@example.com' });

    expect(res.status).toBe(409);
  });
});
