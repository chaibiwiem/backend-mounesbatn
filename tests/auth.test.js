process.env.DATABASE_URL = '';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'root';
process.env.DB_PASS = process.env.DB_PASS || '';
process.env.DB_NAME = 'farahbooking_test';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_EXPIRES_IN = '1h';
process.env.JWT_REFRESH_SECRET = 'test_jwt_refresh_secret';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
process.env.FRONTEND_URL = 'http://localhost:3000';
// Echoue instantanement (ECONNREFUSED) plutot que d'attendre un vrai SMTP :
// sendMail() avale l'erreur, mais un hostname reel ralentirait chaque test.
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const request = require('supertest');
const db = require('../src/models');
const app = require('../src/app');
const emailService = require('../src/services/emailService');

// Les jetons ne sont stockes en base que hashes : on recupere le jeton en
// clair tel qu'il part dans l'email.
const sentVerifyTokens = {};
const sentResetTokens = {};
jest.spyOn(emailService, 'sendVerificationEmail').mockImplementation(async (user, token) => {
  sentVerifyTokens[user.email] = token;
});
jest.spyOn(emailService, 'sendPasswordResetEmail').mockImplementation(async (user, token) => {
  sentResetTokens[user.email] = token;
});

const clientPayload = {
  role: 'client',
  firstName: 'Test',
  lastName: 'Client',
  email: 'test.client@example.com',
  phone: '+21611111111',
  password: 'password123',
};

beforeAll(async () => {
  await db.sequelize.sync({ force: true });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('POST /api/auth/register', () => {
  test('cree un client et renvoie 201 avec emailVerified=false', async () => {
    const res = await request(app).post('/api/auth/register').send(clientPayload);
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(clientPayload.email);
    expect(res.body.user.emailVerified).toBe(false);
  });

  test('rejette un email deja utilise avec 409', async () => {
    const res = await request(app).post('/api/auth/register').send(clientPayload);
    expect(res.status).toBe(409);
  });

  test("ignore un role 'provider' envoye par le client : le compte cree reste 'client'", async () => {
    const res = await request(app).post('/api/auth/register').send({
      role: 'provider',
      firstName: 'Test',
      lastName: 'Provider',
      email: 'attempt.provider@example.com',
      password: 'password123',
      categoryId: 1,
      title: 'Mon Entreprise',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('client');

    const user = await db.User.findOne({ where: { email: 'attempt.provider@example.com' } });
    expect(user.role).toBe('client');
    const listing = await db.Listing.findOne({ where: { userId: user.id } });
    expect(listing).toBeNull();
  });
});

describe('POST /api/auth/login', () => {
  test('refuse la connexion avant verification de l\'email (403)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: clientPayload.email, password: clientPayload.password });
    expect(res.status).toBe(403);
  });

  test('accepte la connexion apres verification et renvoie un token', async () => {
    const user = await db.User.findOne({ where: { email: clientPayload.email } });
    expect(user.emailVerifyToken).not.toBe(sentVerifyTokens[clientPayload.email]);
    const verifyRes = await request(app).get(`/api/auth/verify/${sentVerifyTokens[clientPayload.email]}`);
    expect(verifyRes.status).toBe(200);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: clientPayload.email, password: clientPayload.password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeDefined();
    expect(loginRes.body.refreshToken).toBeDefined();
  });

  test('renvoie un message generique 401 pour un mauvais mot de passe', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: clientPayload.email, password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Identifiants invalides.');
  });

  test('renvoie le meme message generique 401 pour un email inexistant', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'inconnu@example.com', password: 'password123' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Identifiants invalides.');
  });
});

describe('POST /api/auth/forgot-password et reset-password', () => {
  test('renvoie toujours le meme message generique, email existant ou non', async () => {
    const resUnknown = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'ne-existe-pas@example.com' });
    const resKnown = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: clientPayload.email });

    expect(resUnknown.status).toBe(200);
    expect(resKnown.status).toBe(200);
    expect(resUnknown.body.message).toBe(resKnown.body.message);
  });

  test('reinitialise le mot de passe avec un token valide et permet la reconnexion', async () => {
    const user = await db.User.findOne({ where: { email: clientPayload.email } });
    expect(user.resetToken).toBeTruthy();
    expect(user.resetToken).not.toBe(sentResetTokens[clientPayload.email]);

    const resetRes = await request(app)
      .post(`/api/auth/reset-password/${sentResetTokens[clientPayload.email]}`)
      .send({ password: 'newpassword123' });
    expect(resetRes.status).toBe(200);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: clientPayload.email, password: 'newpassword123' });
    expect(loginRes.status).toBe(200);
  });

  test('rejette un token de reinitialisation invalide avec 400', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password/token-invalide')
      .send({ password: 'newpassword123' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/auth/change-password', () => {
  test('rejette une requete sans authentification (401)', async () => {
    const res = await request(app)
      .put('/api/auth/change-password')
      .send({ currentPassword: 'newpassword123', newPassword: 'autreMotDePasse123' });
    expect(res.status).toBe(401);
  });

  test('rejette un mauvais mot de passe actuel (401)', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: clientPayload.email, password: 'newpassword123' });

    const res = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: 'mauvaisMotDePasse', newPassword: 'autreMotDePasse123' });
    expect(res.status).toBe(401);
  });

  test('change le mot de passe et invalide l\'ancien', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: clientPayload.email, password: 'newpassword123' });

    const changeRes = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: 'newpassword123', newPassword: 'autreMotDePasse123' });
    expect(changeRes.status).toBe(200);

    const oldLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: clientPayload.email, password: 'newpassword123' });
    expect(oldLoginRes.status).toBe(401);

    const newLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: clientPayload.email, password: 'autreMotDePasse123' });
    expect(newLoginRes.status).toBe(200);
  });
});

describe('GET /api/auth/me', () => {
  test('rejette une requete sans authentification (401)', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('renvoie le profil a jour depuis la base (pas les infos figees du token)', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: clientPayload.email, password: 'autreMotDePasse123' });

    // Simule un champ modifie en base apres la connexion (ex: adminRole
    // attribue plus tard) : /me doit refleter l'etat courant, pas le token.
    await db.User.update({ firstName: 'Modifie' }, { where: { email: clientPayload.email } });

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${loginRes.body.token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.user.firstName).toBe('Modifie');
    expect(meRes.body.user).toHaveProperty('adminRole');
  });
});
