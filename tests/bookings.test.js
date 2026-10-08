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

const { Category, User, Listing, Client, Lead, Booking } = db;

let category;
let providerUser;
let otherProviderUser;
let providerWithoutListingUser;
let platformClientUser;
let listing;
let otherListing;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  category = await Category.create({ name: 'Traiteur', slug: 'traiteur-bookings-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Sonia',
    lastName: 'Trabelsi',
    email: 'provider.bookings.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherProviderUser = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Prestataire',
    email: 'other.provider.bookings.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  providerWithoutListingUser = await User.create({
    role: 'provider',
    firstName: 'Sans',
    lastName: 'Fiche',
    email: 'sans.fiche.bookings.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  platformClientUser = await User.create({
    role: 'client',
    firstName: 'Amina',
    lastName: 'Client Plateforme',
    email: 'amina.platform.bookings.test@example.com',
    phone: '+21620000066',
    passwordHash: 'hash',
    emailVerified: true,
  });

  listing = await Listing.create({
    userId: providerUser.id,
    categoryId: category.id,
    title: 'Traiteur Sonia',
    city: 'Sousse',
    status: 'active',
  });

  otherListing = await Listing.create({
    userId: otherProviderUser.id,
    categoryId: category.id,
    title: 'Autre Prestataire',
    city: 'Tunis',
    status: 'active',
  });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('POST /api/bookings - creation directe (client hors plateforme)', () => {
  test('refuse un provider sans fiche (404)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerWithoutListingUser)}`)
      .send({ clientName: 'Client Test', eventDate: '2026-11-01' });

    expect(res.status).toBe(404);
  });

  test('refuse sans client existant ni nouveau client (400)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ eventDate: '2026-11-01' });

    expect(res.status).toBe(400);
  });

  test('refuse un mode de reglement invalide (400)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientName: 'Client Test', paymentMethod: 'card' });

    expect(res.status).toBe(400);
  });

  test('cree une reservation pour un nouveau client, statut confirme par defaut, et met a jour le CRM', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientName: 'Amira Direct',
        clientEmail: 'amira.direct@example.com',
        clientPhone: '+21620000077',
        eventDate: '2026-11-05',
        totalPrice: 1200,
        deposit: 300,
        paymentMethod: 'cash',
        notes: 'Accord conclu par telephone.',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.leadId).toBeNull();
    expect(res.body.notes).toBe('Accord conclu par telephone.');
    expect(Number(res.body.deposit)).toBe(300);
    expect(res.body.client.name).toBe('Amira Direct');

    const client = await Client.findOne({ where: { listingId: listing.id, email: 'amira.direct@example.com' } });
    expect(client).not.toBeNull();
    expect(client.eventsCount).toBe(1);
    expect(client.tag).toBe('nouveau');
    expect(Number(client.totalAmount)).toBe(1200);
    expect(Number(client.depositAmount)).toBe(300);
  });

  test('reutilise un client existant via clientId', async () => {
    const client = await Client.create({
      listingId: listing.id,
      name: 'Client Existant',
      email: 'client.existant.bookings@example.com',
    });

    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: client.id, eventDate: '2026-11-10' });

    expect(res.status).toBe(201);
    expect(res.body.clientId).toBe(client.id);

    const updated = await Client.findByPk(client.id);
    expect(updated.eventsCount).toBe(1);
  });

  test("refuse un clientId n'appartenant pas a la fiche du prestataire (404)", async () => {
    const foreignClient = await Client.create({
      listingId: otherListing.id,
      name: 'Client Autre Fiche',
    });

    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientId: foreignClient.id, eventDate: '2026-11-11' });

    expect(res.status).toBe(404);
  });

  test('bloque automatiquement la date dans le calendrier (availability)', async () => {
    const createRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientName: 'Client Calendrier', eventDate: '2026-12-24' });
    expect(createRes.status).toBe(201);

    const availabilityRes = await request(app).get(`/api/listings/${listing.id}/availability`);
    expect(availabilityRes.status).toBe(200);
    const entry = availabilityRes.body.find((e) => e.date === '2026-12-24');
    expect(entry).toBeDefined();
    expect(entry.isAvailable).toBe(false);
    expect(entry.source).toBe('booking');
  });
});

describe('POST /api/bookings - heures de debut/fin (calendrier M5)', () => {
  test('accepte startTime/endTime au format HH:MM', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientName: 'Client Horaire',
        eventDate: '2026-12-01',
        startTime: '14:30',
        endTime: '18:00',
      });

    expect(res.status).toBe(201);
    expect(res.body.startTime).toBe('14:30:00');
    expect(res.body.endTime).toBe('18:00:00');
  });

  test('refuse un format horaire invalide (400)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientName: 'Client Horaire Invalide', startTime: '25:99' });

    expect(res.status).toBe(400);
  });

  test('PATCH met a jour startTime/endTime', async () => {
    const createRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientName: 'Client Horaire Modif', eventDate: '2026-12-02' });

    const res = await request(app)
      .patch(`/api/bookings/${createRes.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ startTime: '09:00', endTime: '10:00' });

    // PATCH renvoie l'instance en memoire (pas de re-fetch), contrairement a
    // POST : le format n'est donc pas re-normalise par MySQL (HH:MM, pas
    // HH:MM:SS) - comportement pre-existant de updateBooking, pas specifique
    // a ces deux champs.
    expect(res.status).toBe(200);
    expect(res.body.startTime).toBe('09:00');
    expect(res.body.endTime).toBe('10:00');

    const refetched = await Booking.findByPk(createRes.body.id);
    expect(refetched.startTime).toBe('09:00:00');
    expect(refetched.endTime).toBe('10:00:00');
  });
});

describe('POST /api/bookings - creation depuis un lead converti', () => {
  test("le statut 'client plateforme' est herite du lead (userId), jamais assigne manuellement", async () => {
    const lead = await Lead.create({
      listingId: listing.id,
      userId: platformClientUser.id,
      firstName: 'Amina',
      lastName: 'Client Plateforme',
      email: platformClientUser.email,
      phone: platformClientUser.phone,
      eventDate: '2027-04-01',
      status: 'new',
    });

    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ leadId: lead.id, eventDate: '2027-04-01' });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(platformClientUser.id);
    expect(res.body.client.userId).toBe(platformClientUser.id);

    // La reservation doit apparaitre dans le tableau de bord du client
    const myBookingsRes = await request(app)
      .get('/api/bookings/me')
      .set('Authorization', `Bearer ${tokenFor(platformClientUser)}`);
    expect(myBookingsRes.status).toBe(200);
    expect(myBookingsRes.body.some((b) => b.id === res.body.id)).toBe(true);
  });

  test('cree la reservation, passe le lead a converti et incremente le CRM', async () => {
    const lead = await Lead.create({
      listingId: listing.id,
      firstName: 'Yassine',
      lastName: 'Karray',
      email: 'yassine.lead.bookings@example.com',
      phone: '+21620000088',
      eventDate: '2027-01-15',
      status: 'new',
    });

    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ leadId: lead.id, eventDate: '2027-01-15', totalPrice: 900, paymentMethod: 'rib' });

    expect(res.status).toBe(201);
    expect(res.body.leadId).toBe(lead.id);
    expect(res.body.client.email).toBe('yassine.lead.bookings@example.com');

    const updatedLead = await Lead.findByPk(lead.id);
    expect(updatedLead.status).toBe('converted');
    expect(updatedLead.answeredAt).not.toBeNull();

    const client = await Client.findOne({ where: { listingId: listing.id, email: 'yassine.lead.bookings@example.com' } });
    expect(client.eventsCount).toBe(1);
  });

  test('refuse une seconde reservation pour le meme lead (409)', async () => {
    const lead = await Lead.create({
      listingId: listing.id,
      firstName: 'Sami',
      lastName: 'Ben Ali',
      email: 'sami.lead.bookings@example.com',
      phone: '+21620000099',
      status: 'new',
    });

    const first = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ leadId: lead.id, eventDate: '2027-02-01' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ leadId: lead.id, eventDate: '2027-02-01' });
    expect(second.status).toBe(409);
  });

  test("refuse un lead n'appartenant pas a la fiche du prestataire (404)", async () => {
    const foreignLead = await Lead.create({
      listingId: otherListing.id,
      firstName: 'Foreign',
      lastName: 'Lead',
      email: 'foreign.lead.bookings@example.com',
      phone: '+21620000000',
      status: 'new',
    });

    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ leadId: foreignLead.id, eventDate: '2027-02-05' });

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/bookings/:id', () => {
  test('modifie la date, le montant et les notes', async () => {
    const createRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientName: 'Client A Modifier', eventDate: '2027-03-01' });
    const bookingId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ eventDate: '2027-03-02', totalPrice: 500, notes: 'Acompte reçu en cash.' });

    expect(res.status).toBe(200);
    expect(res.body.eventDate).toBe('2027-03-02');
    expect(Number(res.body.totalPrice)).toBe(500);
    expect(res.body.notes).toBe('Acompte reçu en cash.');
  });

  test("refuse la modification par un prestataire non proprietaire (403)", async () => {
    const createRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientName: 'Client Proprio', eventDate: '2027-03-05' });
    const bookingId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ totalPrice: 999 });

    expect(res.status).toBe(403);
  });

  test('refuse un statut invalide (400)', async () => {
    const createRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientName: 'Client Statut Invalide' });
    const bookingId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ status: 'archived' });

    expect(res.status).toBe(400);
  });

  test('resynchronise le montant total/acompte CRM du client apres modification du montant', async () => {
    const createRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientName: 'Client CRM Sync',
        clientEmail: 'client.crm.sync@example.com',
        eventDate: '2027-03-10',
        totalPrice: 800,
        deposit: 200,
      });
    const clientId = createRes.body.clientId;

    await request(app)
      .patch(`/api/bookings/${createRes.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ totalPrice: 1000, deposit: 400 });

    let client = await Client.findByPk(clientId);
    expect(Number(client.totalAmount)).toBe(1000);
    expect(Number(client.depositAmount)).toBe(400);

    // Une annulation retire cette reservation du cumul CRM (montants
    // declaratifs, jamais un vrai paiement traite par la plateforme).
    await request(app)
      .patch(`/api/bookings/${createRes.body.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ status: 'cancelled' });

    client = await Client.findByPk(clientId);
    expect(Number(client.totalAmount)).toBe(0);
    expect(Number(client.depositAmount)).toBe(0);
  });
});

describe('PATCH /api/bookings/:id/status', () => {
  test('fait transiter le statut', async () => {
    const createRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientName: 'Client Transition Statut' });
    const bookingId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/bookings/${bookingId}/status`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });

  test("refuse le changement de statut par un prestataire non proprietaire (403)", async () => {
    const createRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientName: 'Client Statut Proprio' });
    const bookingId = createRes.body.id;

    const res = await request(app)
      .patch(`/api/bookings/${bookingId}/status`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ status: 'cancelled' });

    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/bookings/:id', () => {
  test("refuse la suppression par un prestataire non proprietaire (403)", async () => {
    const createRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ clientName: 'Client A Supprimer 1', eventDate: '2027-05-01' });

    const res = await request(app)
      .delete(`/api/bookings/${createRes.body.id}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);

    expect(res.status).toBe(403);
  });

  test('renvoie 404 pour une reservation inexistante', async () => {
    const res = await request(app)
      .delete('/api/bookings/999999')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(404);
  });

  test('supprime la reservation et recalcule le compteur CRM du client', async () => {
    const createRes = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientName: 'Client A Supprimer 2',
        clientEmail: 'client.a.supprimer2@example.com',
        eventDate: '2027-05-02',
        totalPrice: 700,
      });
    const bookingId = createRes.body.id;
    const clientId = createRes.body.clientId;

    let client = await Client.findByPk(clientId);
    expect(client.eventsCount).toBe(1);
    expect(Number(client.totalAmount)).toBe(700);

    const res = await request(app)
      .delete(`/api/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);

    const deleted = await Booking.findByPk(bookingId);
    expect(deleted).toBeNull();

    client = await Client.findByPk(clientId);
    expect(client.eventsCount).toBe(0);
    expect(Number(client.totalAmount)).toBe(0);
  });
});

describe('GET /api/listings/:id/bookings', () => {
  test('liste les reservations du prestataire avec client et lead inclus', async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('client');
  });

  test("refuse l'acces a un prestataire non proprietaire (403)", async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);

    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/bookings/:id/cancel (self-service client)', () => {
  test('le client proprietaire peut annuler sa reservation confirmee', async () => {
    const client = await Client.create({ listingId: listing.id, name: 'Client Annulation' });
    const booking = await Booking.create({
      listingId: listing.id,
      clientId: client.id,
      userId: platformClientUser.id,
      eventDate: '2027-06-01',
      status: 'confirmed',
      totalPrice: 500,
    });
    await require('../src/services/crmService').registerConvertedEvent(client);
    await require('../src/services/crmService').recalculateClientFinancials(client);

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(platformClientUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    const reloadedClient = await Client.findByPk(client.id);
    expect(Number(reloadedClient.totalAmount)).toBe(0);
  });

  test("refuse l'annulation par un autre utilisateur (403)", async () => {
    const client = await Client.create({ listingId: listing.id, name: 'Client Annulation Autre' });
    const booking = await Booking.create({
      listingId: listing.id,
      clientId: client.id,
      userId: platformClientUser.id,
      status: 'confirmed',
    });

    const otherClientUser = await User.create({
      role: 'client',
      firstName: 'Autre',
      lastName: 'Client',
      email: 'autre.client.bookings.test@example.com',
      passwordHash: 'hash',
      emailVerified: true,
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(otherClientUser)}`);

    expect(res.status).toBe(403);
  });

  test('refuse une seconde annulation (deja annulee, 409)', async () => {
    const client = await Client.create({ listingId: listing.id, name: 'Client Deja Annule' });
    const booking = await Booking.create({
      listingId: listing.id,
      clientId: client.id,
      userId: platformClientUser.id,
      status: 'cancelled',
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(platformClientUser)}`);

    expect(res.status).toBe(409);
  });

  test('refuse une annulation sur une reservation terminee (409)', async () => {
    const client = await Client.create({ listingId: listing.id, name: 'Client Terminee' });
    const booking = await Booking.create({
      listingId: listing.id,
      clientId: client.id,
      userId: platformClientUser.id,
      status: 'completed',
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(platformClientUser)}`);

    expect(res.status).toBe(409);
  });
});

describe('PATCH /api/bookings/:id/date (self-service client)', () => {
  test('le client proprietaire peut modifier la date', async () => {
    const client = await Client.create({ listingId: listing.id, name: 'Client Date' });
    const booking = await Booking.create({
      listingId: listing.id,
      clientId: client.id,
      userId: platformClientUser.id,
      eventDate: '2027-06-01',
      status: 'confirmed',
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/date`)
      .set('Authorization', `Bearer ${tokenFor(platformClientUser)}`)
      .send({ eventDate: '2027-07-15' });

    expect(res.status).toBe(200);
    expect(res.body.eventDate).toBe('2027-07-15');
  });

  test('refuse une date invalide (400)', async () => {
    const client = await Client.create({ listingId: listing.id, name: 'Client Date Invalide' });
    const booking = await Booking.create({
      listingId: listing.id,
      clientId: client.id,
      userId: platformClientUser.id,
      status: 'confirmed',
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/date`)
      .set('Authorization', `Bearer ${tokenFor(platformClientUser)}`)
      .send({ eventDate: 'not-a-date' });

    expect(res.status).toBe(400);
  });

  test('refuse la modification par un autre utilisateur (403)', async () => {
    const client = await Client.create({ listingId: listing.id, name: 'Client Date Autre' });
    const booking = await Booking.create({
      listingId: listing.id,
      clientId: client.id,
      userId: platformClientUser.id,
      status: 'confirmed',
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/date`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ eventDate: '2027-08-01' });

    expect(res.status).toBe(403);
  });

  test('refuse la modification sur une reservation annulee (409)', async () => {
    const client = await Client.create({ listingId: listing.id, name: 'Client Date Annulee' });
    const booking = await Booking.create({
      listingId: listing.id,
      clientId: client.id,
      userId: platformClientUser.id,
      status: 'cancelled',
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/date`)
      .set('Authorization', `Bearer ${tokenFor(platformClientUser)}`)
      .send({ eventDate: '2027-08-01' });

    expect(res.status).toBe(409);
  });
});
