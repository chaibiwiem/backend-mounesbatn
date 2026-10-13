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
process.env.ENCRYPTION_KEY = 'test_encryption_key_do_not_use_in_prod';

const fs = require('fs');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/models');
const app = require('../src/app');
const { UPLOAD_DIR } = require('../src/middleware/upload');

const { Category, User, Listing, Image, Package, Client, Lead } = db;

let category;
let providerUser;
let otherProviderUser;
let listing;
let preExistingUploadFiles;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)]);
const FAKE_TEXT = Buffer.from('ceci nest pas une image');

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  // Snapshot avant les tests : UPLOAD_DIR est un dossier partage avec la
  // vraie app en dev (photos reelles des prestataires) — on ne doit jamais
  // supprimer autre chose que les fichiers generes par CETTE suite de tests.
  preExistingUploadFiles = fs.existsSync(UPLOAD_DIR)
    ? new Set(fs.readdirSync(UPLOAD_DIR))
    : new Set();

  category = await Category.create({ name: 'DJ', slug: 'dj-provider-space-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Mzoughi',
    email: 'provider.space.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherProviderUser = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Prestataire',
    email: 'other.provider.space.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  listing = await Listing.create({
    userId: providerUser.id,
    categoryId: category.id,
    title: 'DJ Karim Events',
    city: 'Tunis',
    status: 'pending',
  });
});

afterAll(async () => {
  await db.sequelize.close();
  if (fs.existsSync(UPLOAD_DIR)) {
    fs.readdirSync(UPLOAD_DIR)
      .filter((file) => !preExistingUploadFiles.has(file))
      .forEach((file) => fs.unlinkSync(`${UPLOAD_DIR}/${file}`));
  }
});

describe('GET/PATCH /api/listings/me', () => {
  test("renvoie 404 pour un prestataire sans fiche associee", async () => {
    const res = await request(app)
      .get('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);
    expect(res.status).toBe(404);
  });

  test('renvoie la fiche du prestataire connecte, meme non active', async () => {
    const res = await request(app)
      .get('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(listing.id);
  });

  test('met a jour la description et la localisation', async () => {
    const res = await request(app)
      .patch('/api/listings/me')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ description: 'Nouvelle description', city: 'Sousse', categoryId: 999 });

    expect(res.status).toBe(200);
    expect(res.body.description).toBe('Nouvelle description');
    expect(res.body.city).toBe('Sousse');
    // categoryId n'est pas modifiable par le prestataire
    expect(res.body.categoryId).toBe(category.id);
  });

});

describe('Galerie (POST /api/listings/me/images, etc.)', () => {
  test('televerse une photo valide et la definit comme principale (premiere photo)', async () => {
    const res = await request(app)
      .post('/api/listings/me/images')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .attach('image', FAKE_JPEG, 'photo.jpg');

    expect(res.status).toBe(201);
    expect(res.body.isPrimary).toBe(true);
    expect(res.body.url).toMatch(/^\/uploads\/listings\//);
  });

  test('rejette un fichier qui n\'est pas une vraie image (magic bytes invalides)', async () => {
    const res = await request(app)
      .post('/api/listings/me/images')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .attach('image', FAKE_TEXT, 'fake.jpg');

    expect(res.status).toBe(400);
  });

  test('refuse un upload au-dela de 20 photos', async () => {
    await Image.destroy({ where: { listingId: listing.id } });
    const bulk = Array.from({ length: 20 }, (_, i) => ({
      listingId: listing.id,
      url: `/uploads/listings/seed-${i}.jpg`,
      sortOrder: i,
    }));
    await Image.bulkCreate(bulk);

    const res = await request(app)
      .post('/api/listings/me/images')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .attach('image', FAKE_JPEG, 'photo21.jpg');

    expect(res.status).toBe(400);
  });

  test('un autre prestataire ne peut pas reordonner la galerie', async () => {
    const images = await Image.findAll({ where: { listingId: listing.id } });
    const res = await request(app)
      .patch('/api/listings/me/images/reorder')
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ order: images.map((img) => img.id) });

    expect(res.status).toBe(404);
  });

  test('le proprietaire peut reordonner sa galerie', async () => {
    const images = await Image.findAll({ where: { listingId: listing.id }, order: [['sortOrder', 'ASC']] });
    const reversedOrder = [...images].reverse().map((img) => img.id);

    const res = await request(app)
      .patch('/api/listings/me/images/reorder')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ order: reversedOrder });

    expect(res.status).toBe(200);
    const firstImage = await Image.findByPk(reversedOrder[0]);
    expect(firstImage.sortOrder).toBe(0);
  });

  test('DELETE /api/images/:id supprime une photo (proprietaire uniquement)', async () => {
    const image = await Image.findOne({ where: { listingId: listing.id } });

    const forbidden = await request(app)
      .delete(`/api/images/${image.id}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);
    expect(forbidden.status).toBe(404);

    const res = await request(app)
      .delete(`/api/images/${image.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(res.status).toBe(200);

    const deleted = await Image.findByPk(image.id);
    expect(deleted).toBeNull();
  });
});

describe('Logo prestataire (POST/DELETE /api/listings/me/logo)', () => {
  test('televerse un logo valide', async () => {
    const res = await request(app)
      .post('/api/listings/me/logo')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .attach('logo', FAKE_JPEG, 'logo.jpg');

    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toMatch(/^\/uploads\/listings\//);
  });

  test("rejette un fichier qui n'est pas une vraie image", async () => {
    const res = await request(app)
      .post('/api/listings/me/logo')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .attach('logo', FAKE_TEXT, 'fake.jpg');

    expect(res.status).toBe(400);
  });

  test("refuse l'upload pour un prestataire sans fiche (404)", async () => {
    const res = await request(app)
      .post('/api/listings/me/logo')
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .attach('logo', FAKE_JPEG, 'logo.jpg');

    expect(res.status).toBe(404);
  });

  test('un nouvel upload remplace le precedent logo', async () => {
    const before = await Listing.findByPk(listing.id);
    const previousUrl = before.logoUrl;

    const res = await request(app)
      .post('/api/listings/me/logo')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .attach('logo', FAKE_JPEG, 'logo2.jpg');

    expect(res.status).toBe(200);
    expect(res.body.logoUrl).not.toBe(previousUrl);
  });

  test('DELETE supprime le logo', async () => {
    const res = await request(app)
      .delete('/api/listings/me/logo')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toBeNull();
  });
});

describe('Packages (POST/PATCH/DELETE /api/packages)', () => {
  let packageId;

  test('cree un package', async () => {
    const res = await request(app)
      .post('/api/packages')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ name: 'Pack Soiree', price: 1200, priceType: 'from' });

    expect(res.status).toBe(201);
    packageId = res.body.id;
  });

  test('modifie le package', async () => {
    const res = await request(app)
      .patch(`/api/packages/${packageId}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ price: 1500 });

    expect(res.status).toBe(200);
    expect(Number(res.body.price)).toBe(1500);
  });

  test("refuse la modification par un prestataire non proprietaire", async () => {
    const res = await request(app)
      .patch(`/api/packages/${packageId}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ price: 1 });

    expect(res.status).toBe(404);
  });

  test('supprime le package', async () => {
    const res = await request(app)
      .delete(`/api/packages/${packageId}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(res.status).toBe(200);

    const pkg = await Package.findByPk(packageId);
    expect(pkg).toBeNull();
  });
});

describe('Disponibilites (POST /api/availability, GET public)', () => {
  // Le calendrier n'est pas inclus dans Starter (calendarEnabled, cf.
  // planService.PLAN_CATALOG) : abonnement Pro limite a ce bloc pour ne pas
  // modifier les quotas Starter attendus par les autres blocs du fichier.
  let proSubscription;
  beforeAll(async () => {
    proSubscription = await db.Subscription.create({
      userId: providerUser.id,
      plan: 'pro',
      price: 59,
      billingCycle: 'monthly',
      status: 'active',
      startDate: new Date().toISOString().slice(0, 10),
    });
  });
  afterAll(async () => {
    await proSubscription.destroy();
  });

  test('refuse le calendrier a un plan qui ne l\'inclut pas (Starter, 403)', async () => {
    proSubscription.plan = 'starter';
    await proSubscription.save();
    const res = await request(app)
      .post('/api/availability')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ date: '2026-12-25', isAvailable: false });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Starter/);
    proSubscription.plan = 'pro';
    await proSubscription.save();
  });

  test('bloque une date avec un tarif specifique', async () => {
    const res = await request(app)
      .post('/api/availability')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ date: '2026-12-24', isAvailable: false, priceOverride: 2000 });

    expect(res.status).toBe(201);
    expect(res.body.isAvailable).toBe(false);
  });

  test('le calendrier est visible publiquement', async () => {
    const res = await request(app).get(`/api/listings/${listing.id}/availability`);
    expect(res.status).toBe(200);
    expect(res.body.some((entry) => entry.date === '2026-12-24')).toBe(true);
  });
});

describe('Promotions (POST/PATCH/DELETE /api/promotions, GET public)', () => {
  let promotionId;

  test('cree une promotion active', async () => {
    const res = await request(app)
      .post('/api/promotions')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ type: 'percent', value: 10, label: '-10% nouveaux clients' });

    expect(res.status).toBe(201);
    promotionId = res.body.id;
  });

  test('la promotion active apparait sur GET public', async () => {
    const res = await request(app).get(`/api/listings/${listing.id}/promotions`);
    expect(res.status).toBe(200);
    expect(res.body.some((p) => p.id === promotionId)).toBe(true);
  });

  test('la desactivation retire la promotion du GET public', async () => {
    await request(app)
      .patch(`/api/promotions/${promotionId}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ isActive: false });

    const res = await request(app).get(`/api/listings/${listing.id}/promotions`);
    expect(res.body.some((p) => p.id === promotionId)).toBe(false);
  });
});

describe('Mini-CRM (clients)', () => {
  beforeAll(async () => {
    // Un lead ne peut etre cree que sur une fiche 'active' (Phase 4) :
    // on active la fiche ici, une fois les tests sur le statut 'pending' termines.
    await listing.update({ status: 'active' });
  });

  test('une fiche client est auto-creee a la reception d\'un lead', async () => {
    const leadRes = await request(app)
      .post('/api/leads')
      .send({
        listingId: listing.id,
        firstName: 'Sami',
        lastName: 'Trabelsi',
        email: 'sami.crm.test@example.com',
        phone: '+21620000088',
        guests: '100-150',
      });
    expect(leadRes.status).toBe(201);

    const res = await request(app)
      .get('/api/clients')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    const client = res.body.find((c) => c.email === 'sami.crm.test@example.com');
    expect(client).toBeDefined();
    expect(client.tag).toBe('nouveau');
  });

  test('la conversion d\'un lead incremente eventsCount et peut faire passer le tag a recurrent', async () => {
    const clients = await Client.findAll({ where: { listingId: listing.id, email: 'sami.crm.test@example.com' } });
    const client = clients[0];

    // Simule 2 conversions successives (2 evenements -> recurrent)
    for (let i = 0; i < 2; i += 1) {
      const lead = await Lead.create({
        listingId: listing.id,
        firstName: 'Sami',
        lastName: 'Trabelsi',
        email: 'sami.crm.test@example.com',
        phone: '+21620000088',
        status: 'new',
      });

      await request(app)
        .patch(`/api/leads/${lead.id}/status`)
        .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
        .send({ status: 'converted' });
    }

    const updated = await Client.findByPk(client.id);
    expect(updated.eventsCount).toBe(2);
    expect(updated.tag).toBe('recurrent');
  });

  test('un montant declare > 5000 DT fait passer le tag a vip', async () => {
    const client = await Client.findOne({ where: { listingId: listing.id, email: 'sami.crm.test@example.com' } });

    const res = await request(app)
      .patch(`/api/clients/${client.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ totalAmount: 6000 });

    expect(res.status).toBe(200);
    expect(res.body.tag).toBe('vip');
  });

  test('une surcharge manuelle du tag est respectee tant qu\'elle n\'est pas levee', async () => {
    const client = await Client.findOne({ where: { listingId: listing.id, email: 'sami.crm.test@example.com' } });

    const overrideRes = await request(app)
      .patch(`/api/clients/${client.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ tag: 'nouveau' });
    expect(overrideRes.body.tag).toBe('nouveau');

    // Un changement de montant ne doit plus ecraser le tag surcharge
    const amountRes = await request(app)
      .patch(`/api/clients/${client.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ totalAmount: 8000 });
    expect(amountRes.body.tag).toBe('nouveau');

    const clearRes = await request(app)
      .patch(`/api/clients/${client.id}/clear-manual-tag`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(clearRes.body.tag).toBe('vip');
  });

  test('recherche/filtre par tag et export CSV', async () => {
    const filterRes = await request(app)
      .get('/api/clients')
      .query({ tag: 'vip' })
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(filterRes.status).toBe(200);
    expect(filterRes.body.every((c) => c.tag === 'vip')).toBe(true);

    const exportRes = await request(app)
      .get('/api/clients/export')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers['content-type']).toMatch(/text\/csv/);
    expect(exportRes.text).toContain('Sami Trabelsi');
  });

  test('la suppression est bloquee pour un client ayant un historique (bookings)', async () => {
    const client = await Client.findOne({ where: { listingId: listing.id, email: 'sami.crm.test@example.com' } });

    const res = await request(app)
      .delete(`/api/clients/${client.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(409);
    const stillExists = await Client.findByPk(client.id);
    expect(stillExists).not.toBeNull();
  });

  test('un client sans historique peut etre supprime', async () => {
    const client = await Client.create({
      listingId: listing.id,
      name: 'Client Sans Historique',
      email: 'sans.historique@example.com',
      phone: '+21620000099',
    });

    const res = await request(app)
      .delete(`/api/clients/${client.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(204);
    const deleted = await Client.findByPk(client.id);
    expect(deleted).toBeNull();
  });
});

describe('GET/PATCH /api/listings/me/email-settings (M5 - Email SMTP)', () => {
  test('renvoie 404 pour un prestataire sans fiche associee', async () => {
    const res = await request(app)
      .get('/api/listings/me/email-settings')
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);
    expect(res.status).toBe(404);
  });

  test('renvoie une config vide par defaut, sans secret', async () => {
    const res = await request(app)
      .get('/api/listings/me/email-settings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      provider: null,
      host: '',
      port: '',
      user: '',
      fromEmail: '',
      hasPassword: false,
      hasApiKey: false,
    });
  });

  test('rejette un fournisseur email invalide', async () => {
    const res = await request(app)
      .patch('/api/listings/me/email-settings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ provider: 'yahoo' });
    expect(res.status).toBe(400);
  });

  test('enregistre une config SMTP : le mot de passe est chiffre en base, jamais renvoye', async () => {
    const res = await request(app)
      .patch('/api/listings/me/email-settings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        provider: 'smtp',
        host: 'smtp.gmail.com',
        port: 587,
        user: 'prestataire@gmail.com',
        fromEmail: 'prestataire@gmail.com',
        pass: 'mon-mot-de-passe-application',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      provider: 'smtp',
      host: 'smtp.gmail.com',
      port: 587,
      user: 'prestataire@gmail.com',
      fromEmail: 'prestataire@gmail.com',
      hasPassword: true,
      hasApiKey: false,
    });
    // Le corps de reponse ne contient jamais le mot de passe, ni en clair ni chiffre.
    expect(JSON.stringify(res.body)).not.toContain('mon-mot-de-passe-application');

    const stored = await Listing.findByPk(listing.id);
    expect(stored.emailSettings.passEncrypted).toBeTruthy();
    expect(stored.emailSettings.passEncrypted).not.toBe('mon-mot-de-passe-application');
  });

  test('conserve le mot de passe deja enregistre si non fourni dans la requete', async () => {
    const before = await Listing.findByPk(listing.id);
    const previousEncrypted = before.emailSettings.passEncrypted;

    const res = await request(app)
      .patch('/api/listings/me/email-settings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ host: 'smtp.gmail.com', port: 465 });

    expect(res.status).toBe(200);
    expect(res.body.hasPassword).toBe(true);

    const after = await Listing.findByPk(listing.id);
    expect(after.emailSettings.passEncrypted).toBe(previousEncrypted);
    expect(after.emailSettings.port).toBe(465);
  });

  test('un mot de passe vide explicite efface le secret enregistre', async () => {
    const res = await request(app)
      .patch('/api/listings/me/email-settings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ pass: '' });

    expect(res.status).toBe(200);
    expect(res.body.hasPassword).toBe(false);

    const stored = await Listing.findByPk(listing.id);
    expect(stored.emailSettings.passEncrypted).toBeNull();
  });

  test('POST .../test refuse une requete sans fiche associee (404)', async () => {
    const res = await request(app)
      .post('/api/listings/me/email-settings/test')
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ to: 'client@example.com' });
    expect(res.status).toBe(404);
  });

  test('POST .../test renvoie une erreur claire (422) si l\'envoi echoue', async () => {
    // SMTP de test delibrement injoignable (127.0.0.1:1, cf. env de test) :
    // verifie que l'echec est remonte au prestataire plutot que masque.
    const res = await request(app)
      .post('/api/listings/me/email-settings/test')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ to: 'client@example.com' });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Échec de l'envoi/);
  });
});
