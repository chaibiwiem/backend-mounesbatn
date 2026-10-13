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
const { VIDEO_UPLOAD_DIR, UPLOAD_DIR } = require('../src/middleware/upload');

const { Category, User, Listing, Video, Subscription } = db;

let category;
let providerUser;
let otherProviderUser;
let listing;
let thumbnailListing;
let thumbnailProviderUser;
let preExistingVideoFiles;
let preExistingUploadFiles;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// Fausse video MP4 : signature 'ftyp' a l'offset 4, comme un vrai fichier.
const FAKE_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftyp'),
  Buffer.alloc(50),
]);
const FAKE_TEXT = Buffer.from('ceci nest pas une video');
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)]);

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  preExistingVideoFiles = fs.existsSync(VIDEO_UPLOAD_DIR)
    ? new Set(fs.readdirSync(VIDEO_UPLOAD_DIR))
    : new Set();
  preExistingUploadFiles = fs.existsSync(UPLOAD_DIR) ? new Set(fs.readdirSync(UPLOAD_DIR)) : new Set();

  category = await Category.create({ name: 'DJ', slug: 'dj-videos-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Mzoughi',
    email: 'provider.videos.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherProviderUser = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Prestataire',
    email: 'other.provider.videos.test@example.com',
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

  // Plan Pro (maxVideos: 5, cf. planService.PLAN_CATALOG) : sans abonnement,
  // providerUser retomberait sur Starter (maxVideos: 3, insuffisant pour les
  // scenarios "jusqu'a 5 videos au total" testes plus bas dans ce fichier).
  await Subscription.create({
    userId: providerUser.id,
    plan: 'pro',
    price: 59,
    billingCycle: 'monthly',
    status: 'active',
    startDate: new Date().toISOString().slice(0, 10),
  });

  thumbnailProviderUser = await User.create({
    role: 'provider',
    firstName: 'Vignette',
    lastName: 'Owner',
    email: 'thumbnail.owner.videos.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });
  thumbnailListing = await Listing.create({
    userId: thumbnailProviderUser.id,
    categoryId: category.id,
    title: 'Fiche pour vignettes personnalisees',
    city: 'Tunis',
    status: 'active',
  });
});

afterAll(async () => {
  await db.sequelize.close();
  if (fs.existsSync(VIDEO_UPLOAD_DIR)) {
    fs.readdirSync(VIDEO_UPLOAD_DIR)
      .filter((file) => !preExistingVideoFiles.has(file))
      .forEach((file) => fs.unlinkSync(`${VIDEO_UPLOAD_DIR}/${file}`));
  }
  if (fs.existsSync(UPLOAD_DIR)) {
    fs.readdirSync(UPLOAD_DIR)
      .filter((file) => !preExistingUploadFiles.has(file))
      .forEach((file) => fs.unlinkSync(`${UPLOAD_DIR}/${file}`));
  }
});

describe('POST /api/listings/me/videos (lien YouTube/Vimeo)', () => {
  test('rejette une requete sans url (400)', async () => {
    const res = await request(app)
      .post('/api/listings/me/videos')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('rejette un lien invalide (400)', async () => {
    const res = await request(app)
      .post('/api/listings/me/videos')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ url: 'https://example.com/not-a-video' });
    expect(res.status).toBe(400);
  });

  test('accepte un lien YouTube (watch) et derive embedUrl', async () => {
    const res = await request(app)
      .post('/api/listings/me/videos')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ url: 'https://www.youtube.com/watch?v=abc123', title: 'Teaser mariage' });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('link');
    expect(res.body.embedUrl).toBe('https://www.youtube.com/embed/abc123');
    expect(res.body.thumbnailUrl).toBe('https://img.youtube.com/vi/abc123/hqdefault.jpg');
  });

  test('accepte un lien YouTube court (youtu.be)', async () => {
    const res = await request(app)
      .post('/api/listings/me/videos')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ url: 'https://youtu.be/xyz789' });

    expect(res.status).toBe(201);
    expect(res.body.embedUrl).toBe('https://www.youtube.com/embed/xyz789');
  });

  test('accepte un lien Vimeo', async () => {
    const res = await request(app)
      .post('/api/listings/me/videos')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ url: 'https://vimeo.com/111222333' });

    expect(res.status).toBe(201);
    expect(res.body.embedUrl).toBe('https://player.vimeo.com/video/111222333');
  });
});

describe('POST /api/listings/me/videos/upload (fichier MP4/WebM)', () => {
  test('rejette un fichier qui n\'est pas une vraie video (400)', async () => {
    const res = await request(app)
      .post('/api/listings/me/videos/upload')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .attach('video', FAKE_TEXT, 'fake.mp4');
    expect(res.status).toBe(400);
  });

  test('accepte un vrai fichier MP4 (magic bytes valides)', async () => {
    const res = await request(app)
      .post('/api/listings/me/videos/upload')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .attach('video', FAKE_MP4, 'clip.mp4');

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('upload');
    expect(res.body.embedUrl).toBeNull();
    expect(res.body.thumbnailUrl).toBeNull();
    expect(res.body.url).toMatch(/^\/uploads\/videos\/.+\.mp4$/);
  });

  test('refuse au-dela de 5 videos au total (liens + uploads confondus)', async () => {
    // 4 deja creees dans les blocs precedents (3 liens + 1 upload) ; la 5e passe,
    // la 6e doit etre refusee.
    const fifth = await request(app)
      .post('/api/listings/me/videos')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ url: 'https://vimeo.com/999888777' });
    expect(fifth.status).toBe(201);

    const sixth = await request(app)
      .post('/api/listings/me/videos')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ url: 'https://vimeo.com/444555666' });
    expect(sixth.status).toBe(400);
  });
});

describe('Vignette personnalisee (champ thumbnail)', () => {
  test('rejette une vignette qui n\'est pas une vraie image (400)', async () => {
    const res = await request(app)
      .post('/api/listings/me/videos')
      .set('Authorization', `Bearer ${tokenFor(thumbnailProviderUser)}`)
      .field('url', 'https://vimeo.com/555666777')
      .attach('thumbnail', FAKE_TEXT, 'fake.jpg');
    expect(res.status).toBe(400);
  });

  test('une vignette JPG personnalisee prime sur celle derivee automatiquement (YouTube)', async () => {
    const res = await request(app)
      .post('/api/listings/me/videos')
      .set('Authorization', `Bearer ${tokenFor(thumbnailProviderUser)}`)
      .field('url', 'https://www.youtube.com/watch?v=custom1')
      .attach('thumbnail', FAKE_JPEG, 'cover.jpg');

    expect(res.status).toBe(201);
    expect(res.body.thumbnailUrl).toMatch(/^\/uploads\/listings\/.+\.jpg$/);
    expect(res.body.thumbnailUrl).not.toBe('https://img.youtube.com/vi/custom1/hqdefault.jpg');
  });

  test('une vignette personnalisee fonctionne aussi pour un upload de fichier video', async () => {
    const res = await request(app)
      .post('/api/listings/me/videos/upload')
      .set('Authorization', `Bearer ${tokenFor(thumbnailProviderUser)}`)
      .attach('video', FAKE_MP4, 'clip.mp4')
      .attach('thumbnail', FAKE_JPEG, 'cover2.jpg');

    expect(res.status).toBe(201);
    expect(res.body.thumbnailUrl).toMatch(/^\/uploads\/listings\/.+\.jpg$/);
  });

  test('la suppression retire aussi le fichier de vignette personnalisee du disque', async () => {
    const video = await Video.findOne({
      where: { listingId: thumbnailListing.id, type: 'upload' },
    });
    const thumbnailPath = `${UPLOAD_DIR}/${video.thumbnailUrl.split('/').pop()}`;
    expect(fs.existsSync(thumbnailPath)).toBe(true);

    const res = await request(app)
      .delete(`/api/videos/${video.id}`)
      .set('Authorization', `Bearer ${tokenFor(thumbnailProviderUser)}`);
    expect(res.status).toBe(200);

    expect(fs.existsSync(thumbnailPath)).toBe(false);
  });
});

describe('PATCH /api/videos/:id (ajouter/remplacer une vignette apres coup)', () => {
  test('un autre prestataire ne peut pas modifier la video (404)', async () => {
    const video = await Video.findOne({ where: { listingId: listing.id, type: 'link' } });
    const res = await request(app)
      .patch(`/api/videos/${video.id}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .attach('thumbnail', FAKE_JPEG, 'cover.jpg');
    expect(res.status).toBe(404);
  });

  test('rejette une vignette qui n\'est pas une vraie image (400)', async () => {
    const video = await Video.findOne({ where: { listingId: listing.id, type: 'link' } });
    const res = await request(app)
      .patch(`/api/videos/${video.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .attach('thumbnail', FAKE_TEXT, 'fake.jpg');
    expect(res.status).toBe(400);
  });

  test('ajoute une vignette a un lien Vimeo qui n\'en avait pas', async () => {
    const video = await Video.findOne({
      where: { listingId: listing.id, type: 'link', thumbnailUrl: null },
    });
    expect(video).not.toBeNull();

    const res = await request(app)
      .patch(`/api/videos/${video.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .attach('thumbnail', FAKE_JPEG, 'cover.jpg');

    expect(res.status).toBe(200);
    expect(res.body.thumbnailUrl).toMatch(/^\/uploads\/listings\/.+\.jpg$/);
  });

  test('remplace une vignette personnalisee existante et retire l\'ancien fichier du disque', async () => {
    const video = await Video.findOne({ where: { listingId: thumbnailListing.id, type: 'link' } });
    const oldThumbnailPath = `${UPLOAD_DIR}/${video.thumbnailUrl.split('/').pop()}`;
    expect(fs.existsSync(oldThumbnailPath)).toBe(true);

    const res = await request(app)
      .patch(`/api/videos/${video.id}`)
      .set('Authorization', `Bearer ${tokenFor(thumbnailProviderUser)}`)
      .attach('thumbnail', FAKE_JPEG, 'nouvelle-cover.jpg');

    expect(res.status).toBe(200);
    expect(res.body.thumbnailUrl).not.toBe(video.thumbnailUrl);
    expect(fs.existsSync(oldThumbnailPath)).toBe(false);
  });

  test('modifie uniquement le titre sans toucher a la vignette', async () => {
    const video = await Video.findOne({ where: { listingId: listing.id, type: 'link' } });
    const res = await request(app)
      .patch(`/api/videos/${video.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('title', 'Nouveau titre');

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Nouveau titre');
    expect(res.body.thumbnailUrl).toBe(video.thumbnailUrl);
  });
});

describe('GET /api/listings/:id/videos (public) et DELETE /api/videos/:id', () => {
  test('la liste publique renvoie les videos de la fiche', async () => {
    const res = await request(app).get(`/api/listings/${listing.id}/videos`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
  });

  test('la fiche detail publique inclut les videos', async () => {
    const res = await request(app).get(`/api/listings/${listing.id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.videos)).toBe(true);
    expect(res.body.videos.length).toBeGreaterThanOrEqual(5);
  });

  test('un autre prestataire ne peut pas supprimer la video', async () => {
    const video = await Video.findOne({ where: { listingId: listing.id } });
    const res = await request(app)
      .delete(`/api/videos/${video.id}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);
    expect(res.status).toBe(404);
  });

  test('le proprietaire peut supprimer une video uploadee et le fichier est retire du disque', async () => {
    const video = await Video.findOne({ where: { listingId: listing.id, type: 'upload' } });
    const filePath = `${VIDEO_UPLOAD_DIR}/${video.url.split('/').pop()}`;
    expect(fs.existsSync(filePath)).toBe(true);

    const res = await request(app)
      .delete(`/api/videos/${video.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(res.status).toBe(200);

    expect(fs.existsSync(filePath)).toBe(false);
    const deleted = await Video.findByPk(video.id);
    expect(deleted).toBeNull();
  });
});
