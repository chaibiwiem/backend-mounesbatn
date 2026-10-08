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
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/models');
const app = require('../src/app');
const { UPLOAD_DIR } = require('../src/middleware/upload');

const { Category, User, Listing, Lead, Booking, Review, Dispute, Subscription, Image, SubscriptionInvoice, City } = db;

const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)]);
const FAKE_TEXT = Buffer.from('pas une image');

let category;
let adminUser;
let moderatorUser;
let supportUser;
let analystUser;
let providerUser;
let clientUser;
let pendingListing;
let activeListing;
let preExistingUploadFiles;

function tokenFor(user) {
  return jwt.sign(
    { id: user.id, role: user.role, adminRole: user.adminRole || null },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  // Snapshot avant les tests : UPLOAD_DIR est un dossier partage avec la
  // vraie app en dev (photos reelles des prestataires) — on ne doit jamais
  // supprimer autre chose que les fichiers generes par CETTE suite de tests.
  preExistingUploadFiles = fs.existsSync(UPLOAD_DIR)
    ? new Set(fs.readdirSync(UPLOAD_DIR))
    : new Set();

  category = await Category.create({ name: 'DJ', slug: 'dj-admin-test' });

  adminUser = await User.create({
    role: 'admin',
    adminRole: 'super_admin',
    firstName: 'Admin',
    lastName: 'Mounesba',
    email: 'admin.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  moderatorUser = await User.create({
    role: 'admin',
    adminRole: 'moderator',
    firstName: 'Moderateur',
    lastName: 'Mounesba',
    email: 'moderateur.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  supportUser = await User.create({
    role: 'admin',
    adminRole: 'support',
    firstName: 'Support',
    lastName: 'Mounesba',
    email: 'support.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  analystUser = await User.create({
    role: 'admin',
    adminRole: 'analyst',
    firstName: 'Analyste',
    lastName: 'Mounesba',
    email: 'analyste.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Mzoughi',
    email: 'provider.admin.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  clientUser = await User.create({
    role: 'client',
    firstName: 'Amina',
    lastName: 'Client',
    email: 'client.admin.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  pendingListing = await Listing.create({
    userId: providerUser.id,
    categoryId: category.id,
    title: 'DJ Karim Events',
    city: 'Tunis',
    status: 'pending',
  });

  activeListing = await Listing.create({
    userId: providerUser.id,
    categoryId: category.id,
    title: 'DJ Karim Events (2eme fiche)',
    city: 'Sousse',
    status: 'active',
  });

  await Subscription.create({
    userId: providerUser.id,
    plan: 'pro',
    price: 59,
    status: 'active',
    startDate: '2026-01-01',
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

describe('Controle d\'acces admin', () => {
  test('refuse un non-admin (403)', async () => {
    const res = await request(app)
      .get('/api/admin/providers/pending')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(403);
  });
});

describe('Validation des prestataires (US-A01)', () => {
  test('liste les fiches en attente', async () => {
    const res = await request(app)
      .get('/api/admin/providers/pending')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.some((l) => l.id === pendingListing.id)).toBe(true);
    expect(res.body.some((l) => l.id === activeListing.id)).toBe(false);
  });

  test('rejette un rejet sans motif (400)', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${pendingListing.id}/review`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ decision: 'reject' });

    expect(res.status).toBe(400);
  });

  test('approuve une fiche (statut active)', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${pendingListing.id}/review`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ decision: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  test('rejette une fiche avec motif', async () => {
    const otherListing = await Listing.create({
      userId: providerUser.id,
      categoryId: category.id,
      title: 'Fiche a rejeter',
      city: 'Tunis',
      status: 'pending',
    });

    const res = await request(app)
      .patch(`/api/admin/providers/${otherListing.id}/review`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ decision: 'reject', reason: 'Documents incomplets.' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.rejectReason).toBe('Documents incomplets.');
  });
});

describe('GET /api/admin/providers (table complete)', () => {
  test('refuse un non-admin (403)', async () => {
    const res = await request(app)
      .get('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(res.status).toBe(403);
  });

  test('liste tous les statuts avec pagination', async () => {
    const res = await request(app)
      .get('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.listings)).toBe(true);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(3);
    expect(res.body.listings.some((l) => l.id === activeListing.id)).toBe(true);
  });

  test('filtre par statut', async () => {
    const res = await request(app)
      .get('/api/admin/providers')
      .query({ status: 'rejected' })
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.listings.every((l) => l.status === 'rejected')).toBe(true);
    expect(res.body.listings.some((l) => l.title === 'Fiche a rejeter')).toBe(true);
  });

  test('recherche par nom du gerant', async () => {
    const res = await request(app)
      .get('/api/admin/providers')
      .query({ q: 'Mzoughi' })
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.listings.length).toBeGreaterThanOrEqual(1);
    expect(res.body.listings.every((l) => l.owner.lastName === 'Mzoughi')).toBe(true);
  });

  test('recherche sans resultat renvoie une liste vide', async () => {
    const res = await request(app)
      .get('/api/admin/providers')
      .query({ q: 'AucunPrestataireAvecCeNom' })
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.listings).toHaveLength(0);
  });
});

describe('Suspension / reactivation de fiche', () => {
  test('suspend puis reactive une fiche', async () => {
    const suspendRes = await request(app)
      .patch(`/api/admin/listings/${activeListing.id}/suspend`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(suspendRes.status).toBe(200);
    expect(suspendRes.body.status).toBe('suspended');

    const reactivateRes = await request(app)
      .patch(`/api/admin/listings/${activeListing.id}/reactivate`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.status).toBe('active');
  });
});

describe('Gestion du cycle de vie d\'une fiche (M10 - roles admin)', () => {
  let editableListing;
  let statusListing;
  let deleteListing;

  beforeEach(async () => {
    editableListing = await Listing.create({
      userId: providerUser.id,
      categoryId: category.id,
      title: 'Fiche a modifier',
      city: 'Tunis',
      status: 'active',
    });
    statusListing = await Listing.create({
      userId: providerUser.id,
      categoryId: category.id,
      title: 'Fiche a activer/desactiver',
      city: 'Tunis',
      status: 'active',
    });
    deleteListing = await Listing.create({
      userId: providerUser.id,
      categoryId: category.id,
      title: 'Fiche a supprimer',
      city: 'Tunis',
      status: 'active',
    });
  });

  test('PATCH /providers/:id refuse un moderateur (403)', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${editableListing.id}`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`)
      .send({ title: 'Nouveau titre' });
    expect(res.status).toBe(403);
  });

  test('PATCH /providers/:id modifie la fiche (Super Admin)', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${editableListing.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ title: 'Titre modifie par admin', city: 'Sfax', priceFrom: 100 });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Titre modifie par admin');
    expect(res.body.city).toBe('Sfax');
    expect(Number(res.body.priceFrom)).toBe(100);
  });

  test('PATCH /providers/:id modifie le gerant et la matricule fiscale (Super Admin)', async () => {
    const owner = await User.create({
      role: 'provider',
      firstName: 'Ancien',
      lastName: 'Gerant',
      email: 'ancien.gerant.test@example.com',
      passwordHash: 'hash',
      emailVerified: true,
    });
    const ownedListing = await Listing.create({
      userId: owner.id,
      categoryId: category.id,
      title: 'Fiche gerant',
      status: 'active',
    });

    const res = await request(app)
      .patch(`/api/admin/providers/${ownedListing.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({
        taxId: '1234567A/B/C/000',
        ownerFirstName: 'Nouveau',
        ownerLastName: 'Gerant',
        ownerEmail: 'nouveau.gerant.test@example.com',
        ownerPhone: '+21658799209',
      });

    expect(res.status).toBe(200);
    expect(res.body.taxId).toBe('1234567A/B/C/000');
    await owner.reload();
    expect(owner.firstName).toBe('Nouveau');
    expect(owner.email).toBe('nouveau.gerant.test@example.com');
    expect(owner.phone).toBe('+21658799209');
  });

  test('PATCH /providers/:id refuse un email gerant deja utilise (409)', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${editableListing.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ ownerEmail: adminUser.email });

    expect(res.status).toBe(409);
  });

  test('carte CIN : ajout, consultation et suppression (Super Admin uniquement)', async () => {
    const { LEGAL_UPLOAD_DIR } = require('../src/middleware/upload');

    const forbidden = await request(app)
      .get(`/api/admin/providers/${editableListing.id}/cin`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`);
    expect(forbidden.status).toBe(403);

    const invalid = await request(app)
      .post(`/api/admin/providers/${editableListing.id}/cin`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .attach('cinDocument', Buffer.from('pas une image'), 'cin.jpg');
    expect(invalid.status).toBe(400);

    const uploaded = await request(app)
      .post(`/api/admin/providers/${editableListing.id}/cin`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .attach('cinDocument', FAKE_JPEG, 'cin.jpg');
    expect(uploaded.status).toBe(200);

    await editableListing.reload();
    const storedFile = editableListing.cinDocumentUrl;
    expect(storedFile).toBeTruthy();
    expect(fs.existsSync(`${LEGAL_UPLOAD_DIR}/${storedFile}`)).toBe(true);

    const viewed = await request(app)
      .get(`/api/admin/providers/${editableListing.id}/cin`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(viewed.status).toBe(200);

    const deleted = await request(app)
      .delete(`/api/admin/providers/${editableListing.id}/cin`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(deleted.status).toBe(200);
    await editableListing.reload();
    expect(editableListing.cinDocumentUrl).toBeNull();
    // Laisse le temps a fs.unlink (asynchrone) de supprimer le fichier.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(`${LEGAL_UPLOAD_DIR}/${storedFile}`)).toBe(false);
  });

  test('PATCH /providers/:id/status refuse support/analyste (403)', async () => {
    const supportRes = await request(app)
      .patch(`/api/admin/providers/${statusListing.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(supportUser)}`)
      .send({ status: 'suspended' });
    expect(supportRes.status).toBe(403);

    const analystRes = await request(app)
      .patch(`/api/admin/providers/${statusListing.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(analystUser)}`)
      .send({ status: 'suspended' });
    expect(analystRes.status).toBe(403);
  });

  test('PATCH /providers/:id/status autorise le moderateur, avec motif optionnel', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${statusListing.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`)
      .send({ status: 'suspended', reason: 'Documents expires.' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');
    expect(res.body.rejectReason).toBe('Documents expires.');
  });

  test('PATCH /providers/:id/status rejette un statut invalide (400)', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${statusListing.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ status: 'pending' });
    expect(res.status).toBe(400);
  });

  test('DELETE /providers/:id refuse un moderateur (403)', async () => {
    const res = await request(app)
      .delete(`/api/admin/providers/${deleteListing.id}`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`);
    expect(res.status).toBe(403);
  });

  test('DELETE /providers/:id fait un soft delete (Super Admin) : conserve en base, exclu du public', async () => {
    const deleteRes = await request(app)
      .delete(`/api/admin/providers/${deleteListing.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(deleteRes.status).toBe(200);

    const stillInDb = await Listing.findByPk(deleteListing.id, { paranoid: false });
    expect(stillInDb).not.toBeNull();
    expect(stillInDb.deletedAt).not.toBeNull();
    expect(stillInDb.status).toBe('suspended');

    const notFoundByDefault = await Listing.findByPk(deleteListing.id);
    expect(notFoundByDefault).toBeNull();

    const publicDetailRes = await request(app).get(`/api/listings/${deleteListing.id}`);
    expect(publicDetailRes.status).toBe(404);

    const tableRes = await request(app)
      .get('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(tableRes.body.listings.some((l) => l.id === deleteListing.id)).toBe(false);

    const deletedTabRes = await request(app)
      .get('/api/admin/providers/deleted')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(deletedTabRes.status).toBe(200);
    expect(deletedTabRes.body.some((l) => l.id === deleteListing.id)).toBe(true);
  });

  test('POST /providers/:id/restore refuse un moderateur (403), autorise le Super Admin', async () => {
    await request(app)
      .delete(`/api/admin/providers/${deleteListing.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    const forbiddenRes = await request(app)
      .post(`/api/admin/providers/${deleteListing.id}/restore`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`);
    expect(forbiddenRes.status).toBe(403);

    const restoreRes = await request(app)
      .post(`/api/admin/providers/${deleteListing.id}/restore`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.deletedAt).toBeNull();

    const foundAgain = await Listing.findByPk(deleteListing.id);
    expect(foundAgain).not.toBeNull();
  });

  test('POST /providers/:id/restore rejette une fiche non supprimee (409)', async () => {
    const res = await request(app)
      .post(`/api/admin/providers/${editableListing.id}/restore`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(res.status).toBe(409);
  });
});

describe('Tableau de bord global (US-A02)', () => {
  test('renvoie les indicateurs cles', async () => {
    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.providersCount).toBeGreaterThanOrEqual(1);
    expect(res.body.clientsCount).toBeGreaterThanOrEqual(1);
    expect(res.body.activeSubscriptionsCount).toBe(1);
    expect(res.body.subscriptionRevenue).toBe(59);
  });
});

describe('Gestion des litiges (US-A03) et moderation des avis (US-A04)', () => {
  let review;
  let dispute;

  beforeAll(async () => {
    const booking = await Booking.create({
      listingId: activeListing.id,
      userId: clientUser.id,
      status: 'completed',
      eventDate: '2026-02-01',
    });

    review = await Review.create({
      bookingId: booking.id,
      listingId: activeListing.id,
      userId: clientUser.id,
      rating: 1,
      title: 'Avis suspect',
      recommend: false,
      qualityRating: 1,
      responseTimeRating: 1,
      professionalismRating: 1,
      valueRating: 1,
      flexibilityRating: 1,
      comment: 'Avis suspect',
      isVerified: true,
    });

    const reportRes = await request(app)
      .post(`/api/reviews/${review.id}/report`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ type: 'fake_review', description: 'Ce client n\'existe pas dans mon carnet.' });

    dispute = await Dispute.findByPk(reportRes.body.id);
  });

  test('liste les litiges ouverts', async () => {
    const res = await request(app)
      .get('/api/admin/disputes')
      .query({ status: 'open' })
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.some((d) => d.id === dispute.id)).toBe(true);
  });

  test('consulte le detail du litige', async () => {
    const res = await request(app)
      .get(`/api/admin/disputes/${dispute.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.review.id).toBe(review.id);
  });

  test('liste les avis signales', async () => {
    const res = await request(app)
      .get('/api/admin/reviews/reported')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.id === review.id)).toBe(true);
  });

  test('supprime un avis frauduleux et recalcule la note moyenne + resout le litige', async () => {
    const res = await request(app)
      .delete(`/api/admin/reviews/${review.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);

    const deletedReview = await Review.findByPk(review.id);
    expect(deletedReview).toBeNull();

    const updatedListing = await Listing.findByPk(activeListing.id);
    expect(updatedListing.ratingCount).toBe(0);

    const updatedDispute = await Dispute.findByPk(dispute.id);
    expect(updatedDispute.status).toBe('resolved');
  });

  test('peut aussi conserver un avis signale (dismiss) et rejeter le litige', async () => {
    const booking = await Booking.create({
      listingId: activeListing.id,
      userId: clientUser.id,
      status: 'completed',
      eventDate: '2026-03-01',
    });
    const keptReview = await Review.create({
      bookingId: booking.id,
      listingId: activeListing.id,
      userId: clientUser.id,
      rating: 4,
      title: 'Bonne prestation',
      recommend: true,
      qualityRating: 4,
      responseTimeRating: 4,
      professionalismRating: 4,
      valueRating: 4,
      flexibilityRating: 4,
      isVerified: true,
    });
    const reportRes = await request(app)
      .post(`/api/reviews/${keptReview.id}/report`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ type: 'other' });

    const dismissRes = await request(app)
      .patch(`/api/admin/reviews/${keptReview.id}/dismiss`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(dismissRes.status).toBe(200);
    expect(dismissRes.body.isReported).toBe(false);

    const relatedDispute = await Dispute.findByPk(reportRes.body.id);
    expect(relatedDispute.status).toBe('rejected');
  });

  test('met a jour le statut d\'un litige generique', async () => {
    const res = await request(app)
      .patch(`/api/admin/disputes/${dispute.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ status: 'in_review', resolution: 'Analyse en cours.' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_review');
  });
});

describe('POST /api/admin/providers (onboarding assiste)', () => {
  const basePayload = {
    firstName: 'Fatma',
    lastName: 'Ben Ali',
    email: 'fatma.onboarded@example.com',
    phone: '+21620000055',
    title: 'Fatma Traiteur',
    description: 'Traiteur familial, specialite mariages.',
    city: 'Sfax',
    businessPhone: '+21674000000',
  };

  test('refuse un non-admin (403)', async () => {
    const res = await request(app)
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field({ ...basePayload, categoryId: category.id });

    expect(res.status).toBe(403);
  });

  test('rejette une categorie invalide (400)', async () => {
    const res = await request(app)
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .field({ ...basePayload, categoryId: 999999 });

    expect(res.status).toBe(400);
  });

  test('rejette une photo invalide sans rien creer en base (400)', async () => {
    const res = await request(app)
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .field({ ...basePayload, email: 'fatma.badphoto@example.com', categoryId: category.id })
      .attach('photos', FAKE_TEXT, 'fake.jpg');

    expect(res.status).toBe(400);

    const created = await User.findOne({ where: { email: 'fatma.badphoto@example.com' } });
    expect(created).toBeNull();
  });

  test('cree le compte + la fiche active, avec photo et mot de passe temporaire', async () => {
    const res = await request(app)
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .field({ ...basePayload, categoryId: category.id })
      .attach('photos', FAKE_JPEG, 'photo.jpg');

    expect(res.status).toBe(201);
    expect(res.body.listing.status).toBe('active');
    expect(typeof res.body.temporaryPassword).toBe('string');
    expect(res.body.temporaryPassword.length).toBeGreaterThanOrEqual(8);

    const createdUser = await User.findOne({ where: { email: basePayload.email } });
    expect(createdUser.role).toBe('provider');
    expect(createdUser.emailVerified).toBe(true);
    expect(createdUser.resetToken).toBeNull();

    const image = await Image.findOne({ where: { listingId: res.body.listing.id } });
    expect(image).not.toBeNull();
    expect(image.isPrimary).toBe(true);
  });

  test('rejette un document CIN invalide (400)', async () => {
    const res = await request(app)
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .field({ ...basePayload, email: 'fatma.badcin@example.com', phone: '+21620009910', categoryId: category.id })
      .attach('cinDocument', FAKE_TEXT, 'fake.jpg');

    expect(res.status).toBe(400);

    const created = await User.findOne({ where: { email: 'fatma.badcin@example.com' } });
    expect(created).toBeNull();
  });

  test('accepte matricule fiscal + carte CIN (optionnels), jamais exposes publiquement', async () => {
    const res = await request(app)
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .field({
        ...basePayload,
        email: 'fatma.cin@example.com',
        phone: '+21620009911',
        categoryId: category.id,
        taxId: '1234567A/B/C/000',
      })
      .attach('cinDocument', FAKE_JPEG, 'cin.jpg');

    expect(res.status).toBe(201);
    expect(res.body.listing.taxId).toBe('1234567A/B/C/000');
    expect(typeof res.body.listing.cinDocumentUrl).toBe('string');
    // Nom de fichier stocke hors de /uploads (jamais servi statiquement).
    expect(res.body.listing.cinDocumentUrl).not.toMatch(/^\/uploads\//);

    const publicRes = await request(app).get(`/api/listings/${res.body.listing.id}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.taxId).toBeUndefined();
    expect(publicRes.body.cinDocumentUrl).toBeUndefined();
  });

  test('rejette un email deja utilise (409)', async () => {
    const res = await request(app)
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .field({ ...basePayload, categoryId: category.id });

    expect(res.status).toBe(409);
  });

  test('rejette un telephone deja utilise (409)', async () => {
    const res = await request(app)
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .field({
        ...basePayload,
        email: 'fatma.autrephone@example.com',
        categoryId: category.id,
      });

    expect(res.status).toBe(409);
  });

  test('le prestataire peut se connecter avec le mot de passe temporaire puis le changer', async () => {
    const createRes = await request(app)
      .post('/api/admin/providers')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .field({
        ...basePayload,
        email: 'fatma.temppass@example.com',
        phone: '+21620000099',
        categoryId: category.id,
      });

    expect(createRes.status).toBe(201);
    const { temporaryPassword } = createRes.body;

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'fatma.temppass@example.com', password: temporaryPassword });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.listingId).toBeDefined();

    const changeRes = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: temporaryPassword, newPassword: 'nouveauMotDePasse123' });

    expect(changeRes.status).toBe(200);

    const oldLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'fatma.temppass@example.com', password: temporaryPassword });
    expect(oldLoginRes.status).toBe(401);

    const newLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'fatma.temppass@example.com', password: 'nouveauMotDePasse123' });
    expect(newLoginRes.status).toBe(200);
  });
});

describe('PATCH /api/admin/providers/:id/subscription (US-A05)', () => {
  let subscriptionListing;

  beforeAll(async () => {
    const dedicatedProvider = await User.create({
      role: 'provider',
      firstName: 'Sub',
      lastName: 'ScriptionOwner',
      email: 'subscription.owner.test@example.com',
      passwordHash: 'hash',
      emailVerified: true,
    });
    subscriptionListing = await Listing.create({
      userId: dedicatedProvider.id,
      categoryId: category.id,
      title: 'Fiche pour test abonnement',
      city: 'Tunis',
      status: 'active',
    });
  });

  test('refuse un moderateur (403)', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${subscriptionListing.id}/subscription`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`)
      .send({ plan: 'pro' });
    expect(res.status).toBe(403);
  });

  test('rejette un plan invalide (400)', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${subscriptionListing.id}/subscription`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ plan: 'ultra' });
    expect(res.status).toBe(400);
  });

  test('attribue un plan (Super Admin), meme sans abonnement existant', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${subscriptionListing.id}/subscription`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ plan: 'premium' });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('premium');
    expect(Number(res.body.price)).toBe(119);
    expect(res.body.endDate).not.toBeNull();

    const subscription = await Subscription.findOne({ where: { userId: subscriptionListing.userId } });
    expect(subscription.plan).toBe('premium');
  });

  test('permet un reglage manuel complet (dates, montant paye, reference, notes)', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${subscriptionListing.id}/subscription`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({
        plan: 'premium',
        billingCycle: 'yearly',
        status: 'active',
        startDate: '2026-06-07',
        endDate: '2026-11-07',
        price: 0,
        paymentReference: 'VIR-2026-0042',
        notes: 'Reglement recu par virement, offre fondateur.',
      });

    expect(res.status).toBe(200);
    expect(res.body.billingCycle).toBe('yearly');
    expect(res.body.startDate).toBe('2026-06-07');
    expect(res.body.endDate).toBe('2026-11-07');
    expect(Number(res.body.price)).toBe(0);
    expect(res.body.paymentReference).toBe('VIR-2026-0042');
    expect(res.body.notes).toBe('Reglement recu par virement, offre fondateur.');
  });

  test('rejette un statut invalide (400)', async () => {
    const res = await request(app)
      .patch(`/api/admin/providers/${subscriptionListing.id}/subscription`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ plan: 'premium', status: 'bogus' });
    expect(res.status).toBe(400);
  });
});

describe('Gestion des categories (structure de la plateforme)', () => {
  let mainCategory;
  let subCategory;

  test('GET /categories renvoie l\'arbre complet (actives + inactives)', async () => {
    const res = await request(app)
      .get('/api/admin/categories')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /categories refuse un moderateur (403)', async () => {
    const res = await request(app)
      .post('/api/admin/categories')
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`)
      .send({ name: 'Test', slug: 'test-categorie-refus' });
    expect(res.status).toBe(403);
  });

  test('POST /categories rejette un slug invalide (400)', async () => {
    const res = await request(app)
      .post('/api/admin/categories')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ name: 'Test', slug: 'Slug Invalide !!' });
    expect(res.status).toBe(400);
  });

  test('POST /categories cree une categorie principale (Super Admin)', async () => {
    const res = await request(app)
      .post('/api/admin/categories')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ name: 'Gastronomie', slug: 'gastronomie-test' });

    expect(res.status).toBe(201);
    expect(res.body.parentId).toBeNull();
    mainCategory = res.body;
  });

  test('POST /categories rejette un slug deja utilise (409)', async () => {
    const res = await request(app)
      .post('/api/admin/categories')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ name: 'Doublon', slug: 'gastronomie-test' });
    expect(res.status).toBe(409);
  });

  test('POST /categories cree une sous-categorie', async () => {
    const res = await request(app)
      .post('/api/admin/categories')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ name: 'Chef a domicile', slug: 'chef-domicile-test', parentId: mainCategory.id });

    expect(res.status).toBe(201);
    expect(res.body.parentId).toBe(mainCategory.id);
    subCategory = res.body;
  });

  test('POST /categories refuse d\'imbriquer sous une sous-categorie (400)', async () => {
    const res = await request(app)
      .post('/api/admin/categories')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ name: 'Trop profond', slug: 'trop-profond-test', parentId: subCategory.id });
    expect(res.status).toBe(400);
  });

  test('PATCH /categories/:id modifie le nom et desactive', async () => {
    const res = await request(app)
      .patch(`/api/admin/categories/${subCategory.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ name: 'Chef a domicile (renomme)', isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Chef a domicile (renomme)');
    expect(res.body.isActive).toBe(false);
  });

  test('GET /categories publique n\'affiche plus la categorie desactivee', async () => {
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    const parent = res.body.find((c) => c.id === mainCategory.id);
    expect(parent.children.some((c) => c.id === subCategory.id)).toBe(false);
  });

  test('DELETE /categories/:id refuse si la categorie a des sous-categories (409)', async () => {
    const res = await request(app)
      .delete(`/api/admin/categories/${mainCategory.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(res.status).toBe(409);
  });

  test('DELETE /categories/:id refuse si des prestataires l\'utilisent (409)', async () => {
    const listingOwner = await User.create({
      role: 'provider',
      firstName: 'Cat',
      lastName: 'Owner',
      email: 'category.owner.test@example.com',
      passwordHash: 'hash',
      emailVerified: true,
    });
    await Listing.create({
      userId: listingOwner.id,
      categoryId: subCategory.id,
      title: 'Fiche utilisant la sous-categorie',
      city: 'Tunis',
      status: 'active',
    });

    const res = await request(app)
      .delete(`/api/admin/categories/${subCategory.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(res.status).toBe(409);
  });

  test('DELETE /categories/:id supprime une categorie sans dependances', async () => {
    const orphanCategory = await Category.create({ name: 'A supprimer', slug: 'a-supprimer-test' });

    const res = await request(app)
      .delete(`/api/admin/categories/${orphanCategory.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(res.status).toBe(200);

    const deleted = await Category.findByPk(orphanCategory.id);
    expect(deleted).toBeNull();
  });
});

describe('Gestion des villes / régions', () => {
  let city;

  test('GET /api/cities (public) ne renvoie que les villes actives', async () => {
    const res = await request(app).get('/api/cities');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every((c) => c.isActive)).toBe(true);
  });

  test('GET /admin/cities renvoie toutes les villes (actives + inactives)', async () => {
    const res = await request(app)
      .get('/api/admin/cities')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /cities refuse un moderateur (403)', async () => {
    const res = await request(app)
      .post('/api/admin/cities')
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`)
      .send({ name: 'Ville Test' });
    expect(res.status).toBe(403);
  });

  test('POST /cities rejette un nom vide (400)', async () => {
    const res = await request(app)
      .post('/api/admin/cities')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ name: '' });
    expect(res.status).toBe(400);
  });

  test('POST /cities cree une ville (Super Admin)', async () => {
    const res = await request(app)
      .post('/api/admin/cities')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ name: 'Ville Test Admin' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Ville Test Admin');
    expect(res.body.isActive).toBe(true);
    city = res.body;
  });

  test('POST /cities rejette un nom deja utilise (409)', async () => {
    const res = await request(app)
      .post('/api/admin/cities')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ name: 'Ville Test Admin' });
    expect(res.status).toBe(409);
  });

  test('PATCH /cities/:id modifie le nom et desactive', async () => {
    const res = await request(app)
      .patch(`/api/admin/cities/${city.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ name: 'Ville Test Admin (renommee)', isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Ville Test Admin (renommee)');
    expect(res.body.isActive).toBe(false);
  });

  test('GET /api/cities (public) n\'affiche plus la ville desactivee', async () => {
    const res = await request(app).get('/api/cities');
    expect(res.status).toBe(200);
    expect(res.body.some((c) => c.id === city.id)).toBe(false);
  });

  test('DELETE /cities/:id refuse un moderateur (403)', async () => {
    const res = await request(app)
      .delete(`/api/admin/cities/${city.id}`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`);
    expect(res.status).toBe(403);
  });

  test('DELETE /cities/:id supprime la ville (Super Admin)', async () => {
    const res = await request(app)
      .delete(`/api/admin/cities/${city.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(res.status).toBe(200);

    const deleted = await City.findByPk(city.id);
    expect(deleted).toBeNull();
  });
});

describe('Services associés (liste informative FR/AR par catégorie)', () => {
  let category;
  let service;

  beforeAll(async () => {
    category = await Category.create({ name: 'Evenements pro test', slug: 'evenements-pro-services-test' });
  });

  test('refuse la creation a un moderateur (403)', async () => {
    const res = await request(app)
      .post(`/api/admin/categories/${category.id}/services`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`)
      .send({ nameFr: 'Test' });
    expect(res.status).toBe(403);
  });

  test('rejette un nom (FR) vide (400)', async () => {
    const res = await request(app)
      .post(`/api/admin/categories/${category.id}/services`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ nameFr: '' });
    expect(res.status).toBe(400);
  });

  test('cree un service associe bilingue', async () => {
    const res = await request(app)
      .post(`/api/admin/categories/${category.id}/services`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ nameFr: 'Location de salle de conférence', nameAr: 'كراء قاعة مؤتمرات' });

    expect(res.status).toBe(201);
    expect(res.body.nameFr).toBe('Location de salle de conférence');
    expect(res.body.nameAr).toBe('كراء قاعة مؤتمرات');
    expect(Number(res.body.categoryId)).toBe(category.id);
    service = res.body;
  });

  test('GET /categories (public) inclut associatedServices pour la categorie', async () => {
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    const found = res.body.find((c) => c.id === category.id);
    expect(found).toBeDefined();
    expect(found.associatedServices.some((s) => s.id === service.id)).toBe(true);
  });

  test('PATCH /services/:id modifie le service', async () => {
    const res = await request(app)
      .patch(`/api/admin/services/${service.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ nameFr: 'Location de salle de conférence (modifié)' });

    expect(res.status).toBe(200);
    expect(res.body.nameFr).toBe('Location de salle de conférence (modifié)');
  });

  test('DELETE /services/:id supprime le service', async () => {
    const res = await request(app)
      .delete(`/api/admin/services/${service.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(res.status).toBe(200);

    const deleted = await db.AssociatedService.findByPk(service.id);
    expect(deleted).toBeNull();
  });
});

describe('GET /api/admin/providers - filtre par plan', () => {
  test('filtre par plan renvoie uniquement les prestataires sur ce plan', async () => {
    const premiumProvider = await User.create({
      role: 'provider',
      firstName: 'Premium',
      lastName: 'Owner',
      email: 'premium.owner.filter.test@example.com',
      passwordHash: 'hash',
      emailVerified: true,
    });
    const premiumListing = await Listing.create({
      userId: premiumProvider.id,
      categoryId: category.id,
      title: 'Fiche premium pour filtre',
      city: 'Tunis',
      status: 'active',
    });
    await Subscription.create({
      userId: premiumProvider.id,
      plan: 'premium',
      price: 119,
      billingCycle: 'monthly',
      status: 'active',
      startDate: '2026-01-01',
    });

    const res = await request(app)
      .get('/api/admin/providers')
      .query({ plan: 'premium' })
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.listings.some((l) => l.id === premiumListing.id)).toBe(true);
    expect(res.body.listings.some((l) => l.title === 'Fiche a modifier')).toBe(false);
  });
});

describe('Factures d\'abonnement (facturation admin)', () => {
  let invoiceListing;
  let createdInvoiceId;

  beforeAll(async () => {
    const invoiceProvider = await User.create({
      role: 'provider',
      firstName: 'Facture',
      lastName: 'Owner',
      email: 'facture.owner.test@example.com',
      passwordHash: 'hash',
      emailVerified: true,
    });
    invoiceListing = await Listing.create({
      userId: invoiceProvider.id,
      categoryId: category.id,
      title: 'Fiche pour facture abonnement',
      city: 'Tunis',
      status: 'active',
    });
  });

  test('GET /subscription-invoices accessible a tous les roles admin (lecture)', async () => {
    const res = await request(app)
      .get('/api/admin/subscription-invoices')
      .set('Authorization', `Bearer ${tokenFor(analystUser)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.invoices)).toBe(true);
  });

  test('POST /providers/:id/subscription-invoices refuse un moderateur (403)', async () => {
    const res = await request(app)
      .post(`/api/admin/providers/${invoiceListing.id}/subscription-invoices`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`)
      .send({ amount: 59 });
    expect(res.status).toBe(403);
  });

  test('POST /providers/:id/subscription-invoices rejette un montant invalide (400)', async () => {
    const res = await request(app)
      .post(`/api/admin/providers/${invoiceListing.id}/subscription-invoices`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ amount: -5 });
    expect(res.status).toBe(400);
  });

  test('POST /providers/:id/subscription-invoices cree une facture (Super Admin)', async () => {
    const res = await request(app)
      .post(`/api/admin/providers/${invoiceListing.id}/subscription-invoices`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ amount: 59, status: 'paid' });

    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^FACTURE-\d{4}-\d{4}$/);
    expect(Number(res.body.amount)).toBe(59);
    expect(res.body.status).toBe('paid');
    createdInvoiceId = res.body.id;

    const subscription = await Subscription.findOne({ where: { userId: invoiceListing.userId } });
    expect(subscription).not.toBeNull();
    // La periode facturee reprend exactement les dates de l'abonnement.
    expect(res.body.periodStart).toBe(subscription.startDate);
    expect(res.body.periodEnd).toBe(subscription.endDate);
  });

  test('PATCH /subscription-invoices/:id modifie le montant et le statut', async () => {
    const res = await request(app)
      .patch(`/api/admin/subscription-invoices/${createdInvoiceId}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ amount: 119, status: 'unpaid' });

    expect(res.status).toBe(200);
    expect(Number(res.body.amount)).toBe(119);
    expect(res.body.status).toBe('unpaid');
  });

  test('POST /subscription-invoices/:id/send refuse un moderateur (403)', async () => {
    const res = await request(app)
      .post(`/api/admin/subscription-invoices/${createdInvoiceId}/send`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`);
    expect(res.status).toBe(403);
  });

  test('POST /subscription-invoices/:id/send envoie la facture au prestataire (Super Admin)', async () => {
    const res = await request(app)
      .post(`/api/admin/subscription-invoices/${createdInvoiceId}/send`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.id).toBe(createdInvoiceId);
  });

  test('POST /subscription-invoices/:id/send renvoie 404 pour une facture inexistante', async () => {
    const res = await request(app)
      .post('/api/admin/subscription-invoices/999999/send')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(res.status).toBe(404);
  });

  test('DELETE /subscription-invoices/:id refuse un moderateur (403)', async () => {
    const res = await request(app)
      .delete(`/api/admin/subscription-invoices/${createdInvoiceId}`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`);
    expect(res.status).toBe(403);
  });

  test('DELETE /subscription-invoices/:id supprime la facture (Super Admin)', async () => {
    const res = await request(app)
      .delete(`/api/admin/subscription-invoices/${createdInvoiceId}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(res.status).toBe(200);

    const deleted = await SubscriptionInvoice.findByPk(createdInvoiceId);
    expect(deleted).toBeNull();
  });
});

describe('Statistiques de reservations par prestataire (M10)', () => {
  // Deux fiches avec des profils leads/bookings volontairement opposes,
  // pour verifier que le tri par leads et par bookings donne un ordre
  // vraiment different (pas juste un tri par defaut qui coincide).
  let statsListing;
  let otherStatsListing;

  beforeAll(async () => {
    statsListing = await Listing.create({
      userId: providerUser.id,
      categoryId: category.id,
      title: 'Stats Test - Beaucoup de leads',
      city: 'Tunis',
      status: 'active',
    });

    otherStatsListing = await Listing.create({
      userId: providerUser.id,
      categoryId: category.id,
      title: 'Stats Test - Beaucoup de bookings',
      city: 'Sfax',
      status: 'active',
    });

    // statsListing : 5 leads (2 new, 1 answered, 1 converted, 1 lost) et
    // 2 bookings (1 confirmed, 1 completed).
    const leadDefaults = { listingId: statsListing.id, lastName: 'Test', phone: '20000000' };
    await Lead.create({ ...leadDefaults, firstName: 'A', email: 'stats-a@test.com', status: 'new' });
    await Lead.create({ ...leadDefaults, firstName: 'B', email: 'stats-b@test.com', status: 'new' });
    await Lead.create({
      ...leadDefaults,
      firstName: 'C',
      email: 'stats-c@test.com',
      status: 'answered',
      answeredAt: new Date(),
    });
    const convertedLead = await Lead.create({
      ...leadDefaults,
      firstName: 'D',
      email: 'stats-d@test.com',
      status: 'converted',
      answeredAt: new Date(),
    });
    await Lead.create({
      ...leadDefaults,
      firstName: 'E',
      email: 'stats-e@test.com',
      status: 'lost',
      answeredAt: new Date(),
    });

    // 1 booking issu du lead converti (plateforme) + 1 booking saisi
    // directement par le prestataire, sans lead (hors plateforme).
    await Booking.create({
      listingId: statsListing.id,
      leadId: convertedLead.id,
      userId: clientUser.id,
      status: 'confirmed',
      eventDate: '2027-01-01',
    });
    await Booking.create({
      listingId: statsListing.id,
      userId: clientUser.id,
      status: 'completed',
      eventDate: '2027-02-01',
    });

    // otherStatsListing : 1 seul lead, mais 4 bookings (un par statut).
    await Lead.create({
      listingId: otherStatsListing.id,
      firstName: 'F',
      lastName: 'Test',
      email: 'stats-f@test.com',
      phone: '20000001',
      status: 'new',
    });
    await Booking.bulkCreate([
      { listingId: otherStatsListing.id, userId: clientUser.id, status: 'pending', eventDate: '2027-03-01' },
      { listingId: otherStatsListing.id, userId: clientUser.id, status: 'confirmed', eventDate: '2027-03-02' },
      { listingId: otherStatsListing.id, userId: clientUser.id, status: 'completed', eventDate: '2027-03-03' },
      { listingId: otherStatsListing.id, userId: clientUser.id, status: 'cancelled', eventDate: '2027-03-04' },
    ]);
  });

  describe('Controle d\'acces (lecture seule, tous les sous-roles admin)', () => {
    test.each([
      ['Super Admin', () => adminUser],
      ['Moderateur', () => moderatorUser],
      ['Support', () => supportUser],
      ['Analyste', () => analystUser],
    ])('GET /providers/:id/stats accessible au role %s', async (_label, getUser) => {
      const res = await request(app)
        .get(`/api/admin/providers/${statsListing.id}/stats`)
        .set('Authorization', `Bearer ${tokenFor(getUser())}`);
      expect(res.status).toBe(200);
    });

    test('GET /providers/:id/stats refuse un prestataire (403)', async () => {
      const res = await request(app)
        .get(`/api/admin/providers/${statsListing.id}/stats`)
        .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
      expect(res.status).toBe(403);
    });

    test('GET /providers/:id/stats refuse un client (403)', async () => {
      const res = await request(app)
        .get(`/api/admin/providers/${statsListing.id}/stats`)
        .set('Authorization', `Bearer ${tokenFor(clientUser)}`);
      expect(res.status).toBe(403);
    });

    test('GET /providers/:id/stats refuse une requete sans token (401)', async () => {
      const res = await request(app).get(`/api/admin/providers/${statsListing.id}/stats`);
      expect(res.status).toBe(401);
    });

    test('GET /providers/stats (liste) accessible a l\'Analyste', async () => {
      const res = await request(app)
        .get('/api/admin/providers/stats')
        .set('Authorization', `Bearer ${tokenFor(analystUser)}`);
      expect(res.status).toBe(200);
    });

    test('GET /providers/stats (liste) refuse un client (403)', async () => {
      const res = await request(app)
        .get('/api/admin/providers/stats')
        .set('Authorization', `Bearer ${tokenFor(clientUser)}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Exactitude des agregations (fiche individuelle)', () => {
    test('renvoie 404 pour une fiche inexistante', async () => {
      const res = await request(app)
        .get('/api/admin/providers/999999/stats')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
      expect(res.status).toBe(404);
    });

    test('calcule les totaux, la repartition par statut et les taux', async () => {
      const res = await request(app)
        .get(`/api/admin/providers/${statsListing.id}/stats`)
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

      expect(res.status).toBe(200);
      expect(res.body.leadsTotal).toBe(5);
      expect(res.body.leadsByStatus).toEqual({ new: 2, answered: 1, late: 0, converted: 1, lost: 1 });
      expect(res.body.bookingsTotal).toBe(2);
      expect(res.body.bookingsByStatus).toEqual({ pending: 0, confirmed: 1, completed: 1, cancelled: 0 });
      // 1 booking issu d'un lead converti (plateforme), 1 saisi directement
      // par le prestataire (hors plateforme).
      expect(res.body.bookingsByOrigin).toEqual({ platform: 1, offPlatform: 1 });
      // conversionRate = leads convertis / leads recus = 1 / 5
      expect(res.body.conversionRate).toBeCloseTo(0.2);
      // responseRate = leads repondus (answeredAt renseigne) / leads recus = 3 / 5
      expect(res.body.responseRate).toBeCloseTo(0.6);
      expect(res.body.lastLeadAt).not.toBeNull();
      expect(res.body.lastBookingAt).not.toBeNull();
    });

    test('renvoie des compteurs a zero pour une fiche sans aucun lead/booking', async () => {
      const emptyListing = await Listing.create({
        userId: providerUser.id,
        categoryId: category.id,
        title: 'Stats Test - Fiche vide',
        city: 'Tunis',
        status: 'active',
      });

      const res = await request(app)
        .get(`/api/admin/providers/${emptyListing.id}/stats`)
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

      expect(res.status).toBe(200);
      expect(res.body.leadsTotal).toBe(0);
      expect(res.body.bookingsTotal).toBe(0);
      expect(res.body.conversionRate).toBe(0);
      expect(res.body.responseRate).toBe(0);
      expect(res.body.lastLeadAt).toBeNull();
      expect(res.body.lastBookingAt).toBeNull();
    });
  });

  describe('Filtre par periode (?from&to)', () => {
    test('une periode qui exclut tous les enregistrements renvoie des totaux a zero', async () => {
      const res = await request(app)
        .get(`/api/admin/providers/${statsListing.id}/stats`)
        .query({ from: '2099-01-01', to: '2099-12-31' })
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

      expect(res.status).toBe(200);
      expect(res.body.leadsTotal).toBe(0);
      expect(res.body.bookingsTotal).toBe(0);
      expect(res.body.period).toEqual({ from: '2099-01-01', to: '2099-12-31' });
    });

    test('une periode incluant aujourd\'hui renvoie les totaux complets', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await request(app)
        .get(`/api/admin/providers/${statsListing.id}/stats`)
        .query({ from: '2020-01-01', to: today })
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

      expect(res.status).toBe(200);
      expect(res.body.leadsTotal).toBe(5);
      expect(res.body.bookingsTotal).toBe(2);
    });
  });

  describe('Liste paginee avec compteurs et tri', () => {
    test('renvoie chaque fiche avec ses compteurs agreges', async () => {
      const res = await request(app)
        .get('/api/admin/providers/stats')
        .query({ limit: 100 })
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

      expect(res.status).toBe(200);
      const row = res.body.results.find((r) => r.listingId === statsListing.id);
      expect(row).toBeDefined();
      expect(row.leadsTotal).toBe(5);
      expect(row.bookingsTotal).toBe(2);
      expect(row.bookingsByOrigin).toEqual({ platform: 1, offPlatform: 1 });
      expect(row.conversionRate).toBeCloseTo(0.2);
      expect(row.category).toHaveProperty('name');
    });

    test('sort=leads classe la fiche a forte activite leads avant celle a forte activite bookings', async () => {
      const res = await request(app)
        .get('/api/admin/providers/stats')
        .query({ sort: 'leads', limit: 100 })
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

      expect(res.status).toBe(200);
      const ids = res.body.results.map((r) => r.listingId);
      expect(ids.indexOf(statsListing.id)).toBeLessThan(ids.indexOf(otherStatsListing.id));
    });

    test('sort=bookings inverse le classement par rapport a sort=leads', async () => {
      const res = await request(app)
        .get('/api/admin/providers/stats')
        .query({ sort: 'bookings', limit: 100 })
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

      expect(res.status).toBe(200);
      const ids = res.body.results.map((r) => r.listingId);
      expect(ids.indexOf(otherStatsListing.id)).toBeLessThan(ids.indexOf(statsListing.id));
    });

    test('filtre par ville', async () => {
      const res = await request(app)
        .get('/api/admin/providers/stats')
        .query({ city: 'Sfax', limit: 100 })
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

      expect(res.status).toBe(200);
      expect(res.body.results.every((r) => r.city === 'Sfax')).toBe(true);
      expect(res.body.results.some((r) => r.listingId === otherStatsListing.id)).toBe(true);
    });

    test('respecte la pagination (limit)', async () => {
      const res = await request(app)
        .get('/api/admin/providers/stats')
        .query({ limit: 1, page: 1 })
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`);

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBe(1);
      expect(res.body.pagination.limit).toBe(1);
    });
  });
});

describe('Suppression definitive d\'une fiche et de ses donnees liees (Super Admin)', () => {
  test('refuse sans confirmation du nom, puis supprime la fiche, ses donnees et le compte', async () => {
    const { Client, Invoice, Contract } = db;
    const owner = await User.create({
      role: 'provider',
      firstName: 'Purge',
      lastName: 'Test',
      email: 'purge.provider.test@example.com',
      passwordHash: 'hash',
      emailVerified: true,
    });
    const listing = await Listing.create({
      userId: owner.id,
      categoryId: category.id,
      title: 'Fiche a purger',
      status: 'suspended',
    });
    await Subscription.create({ userId: owner.id, plan: 'starter', price: 0, billingCycle: 'monthly', status: 'active', startDate: '2026-01-01' });
    const lead = await Lead.create({ listingId: listing.id, firstName: 'Sami', lastName: 'T', email: 'sami.purge@example.com', phone: '+21620000099' });
    const client = await Client.create({ listingId: listing.id, name: 'Sami T' });
    const booking = await Booking.create({ listingId: listing.id, leadId: lead.id, clientId: client.id, status: 'completed', eventDate: '2026-02-01' });
    await Review.create({
      bookingId: booking.id, listingId: listing.id, rating: 5, title: 'Tres bien vraiment', recommend: true,
      qualityRating: 5, responseTimeRating: 5, professionalismRating: 5, valueRating: 5, flexibilityRating: 5,
      comment: 'Parfait', isVerified: true,
    });
    await Invoice.create({ listingId: listing.id, clientId: client.id, bookingId: booking.id, number: 'FAC-PURGE-1', amount: 100, status: 'paid' });
    await Contract.create({ listingId: listing.id, clientId: client.id, object: 'Mariage', status: 'draft' });
    await listing.destroy(); // passe dans "Supprimés" (soft delete)

    const preview = await request(app)
      .get(`/api/admin/providers/${listing.id}/force-preview`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(preview.status).toBe(200);
    expect(preview.body.counts).toMatchObject({ leads: 1, bookings: 1, reviews: 1, invoices: 1, contracts: 1, clients: 1 });

    const forbidden = await request(app)
      .delete(`/api/admin/providers/${listing.id}/force`)
      .set('Authorization', `Bearer ${tokenFor(moderatorUser)}`)
      .send({ confirmTitle: 'Fiche a purger' });
    expect(forbidden.status).toBe(403);

    const wrongName = await request(app)
      .delete(`/api/admin/providers/${listing.id}/force`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ confirmTitle: 'autre nom' });
    expect(wrongName.status).toBe(400);
    expect(await Listing.findByPk(listing.id, { paranoid: false })).not.toBeNull();

    const res = await request(app)
      .delete(`/api/admin/providers/${listing.id}/force`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ confirmTitle: 'Fiche a purger', deleteOwnerAccount: true });
    expect(res.status).toBe(200);

    expect(await Listing.findByPk(listing.id, { paranoid: false })).toBeNull();
    expect(await Lead.count({ where: { listingId: listing.id } })).toBe(0);
    expect(await Booking.count({ where: { listingId: listing.id } })).toBe(0);
    expect(await Review.count({ where: { listingId: listing.id } })).toBe(0);
    expect(await Invoice.count({ where: { listingId: listing.id } })).toBe(0);
    expect(await Contract.count({ where: { listingId: listing.id } })).toBe(0);
    expect(await Client.count({ where: { listingId: listing.id } })).toBe(0);
    expect(await User.findByPk(owner.id)).toBeNull();
    expect(await Subscription.count({ where: { userId: owner.id } })).toBe(0);
  });
});
