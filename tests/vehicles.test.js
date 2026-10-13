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
const { UPLOAD_DIR } = require('../src/middleware/upload');

const { Category, User, Listing, Vehicle, VehicleBooking, Lead, VehicleDecoration, Client } = db;

const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)]);
const FAKE_TEXT = Buffer.from('pas une image');

let transportCategory;
let carsSubCategory;
let otherMainCategory;
let providerUser;
let otherProviderUser;
let transportListing;
let nonTransportListing;
let preExistingUploadFiles;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  preExistingUploadFiles = fs.existsSync(UPLOAD_DIR)
    ? new Set(fs.readdirSync(UPLOAD_DIR))
    : new Set();

  // Le controleur verifie le slug litteral 'transport' (celui du seed reel),
  // pas juste le nom - garder ce slug exact ici.
  transportCategory = await Category.create({ name: 'Transport', slug: 'transport' });
  carsSubCategory = await Category.create({
    name: 'Location de voitures',
    slug: 'location-voitures-test',
    parentId: transportCategory.id,
  });
  otherMainCategory = await Category.create({ name: 'Animation', slug: 'animation-vehicles-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Transport',
    email: 'provider.vehicles.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherProviderUser = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Prestataire',
    email: 'other.provider.vehicles.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  transportListing = await Listing.create({
    userId: providerUser.id,
    categoryId: carsSubCategory.id,
    title: 'Karim Location Auto',
    city: 'Tunis',
    status: 'active',
  });

  nonTransportListing = await Listing.create({
    userId: providerUser.id,
    categoryId: otherMainCategory.id,
    title: 'Karim Animation',
    city: 'Tunis',
    status: 'active',
  });
});

afterAll(async () => {
  await db.sequelize.close();
  if (fs.existsSync(UPLOAD_DIR)) {
    fs.readdirSync(UPLOAD_DIR)
      .filter((file) => !preExistingUploadFiles.has(file))
      .forEach((file) => fs.unlinkSync(path.join(UPLOAD_DIR, file)));
  }
});

describe('POST /api/listings/:id/vehicles (ajout a la flotte)', () => {
  test("refuse l'ajout par un prestataire non proprietaire (403)", async () => {
    const res = await request(app)
      .post(`/api/listings/${transportListing.id}/vehicles`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .field('type', 'voiture');

    expect(res.status).toBe(403);
  });

  test("refuse si la fiche n'est pas de categorie Transport (403)", async () => {
    const res = await request(app)
      .post(`/api/listings/${nonTransportListing.id}/vehicles`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('type', 'voiture');

    expect(res.status).toBe(403);
  });

  test('refuse un type de vehicule invalide (400)', async () => {
    const res = await request(app)
      .post(`/api/listings/${transportListing.id}/vehicles`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('type', 'camion');

    expect(res.status).toBe(400);
  });

  test('ajoute un vehicule valide avec photo (201)', async () => {
    const res = await request(app)
      .post(`/api/listings/${transportListing.id}/vehicles`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('type', 'voiture')
      .field('brand', 'Mercedes')
      .field('model', 'Classe S')
      .field('year', '2022')
      .field('seats', '4')
      .field('doors', '5')
      .field('luggage', '3')
      .field('transmission', 'automatique')
      .field('pricePerDay', '250')
      .field('pricePerHour', '35')
      .field('withDriver', 'true')
      .field('airConditioned', 'true')
      .field('hasDecoration', 'true')
      .attach('image', FAKE_JPEG, 'car.jpg');

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('voiture');
    expect(res.body.brand).toBe('Mercedes');
    expect(res.body.doors).toBe(5);
    expect(res.body.luggage).toBe(3);
    expect(res.body.transmission).toBe('automatique');
    expect(Number(res.body.pricePerDay)).toBe(250);
    expect(Number(res.body.pricePerHour)).toBe(35);
    expect(res.body.withDriver).toBe(true);
    expect(res.body.airConditioned).toBe(true);
    expect(res.body.hasDecoration).toBe(true);
    expect(res.body.isAvailable).toBe(true);
    expect(res.body.imageUrl).toMatch(/^\/uploads\/listings\//);
  });

  test('rejette une photo invalide (magic bytes) avec 400', async () => {
    const res = await request(app)
      .post(`/api/listings/${transportListing.id}/vehicles`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('type', 'bus')
      .attach('image', FAKE_TEXT, 'fake.jpg');

    expect(res.status).toBe(400);
  });
});

describe('GET /api/listings/:id/vehicles (flotte publique)', () => {
  let busVehicle;

  beforeAll(async () => {
    busVehicle = await Vehicle.create({
      listingId: transportListing.id,
      type: 'bus',
      brand: 'Iveco',
      seats: 50,
      pricePerDay: 800,
      isAvailable: true,
    });
  });

  test('liste uniquement les vehicules actifs de la flotte', async () => {
    const res = await request(app).get(`/api/listings/${transportListing.id}/vehicles`);

    expect(res.status).toBe(200);
    expect(res.body.some((v) => v.id === busVehicle.id)).toBe(true);
  });

  test("n'affiche plus un vehicule retire (soft delete)", async () => {
    await request(app)
      .delete(`/api/vehicles/${busVehicle.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    const res = await request(app).get(`/api/listings/${transportListing.id}/vehicles`);
    expect(res.status).toBe(200);
    expect(res.body.some((v) => v.id === busVehicle.id)).toBe(false);
  });
});

describe('PATCH /DELETE /api/vehicles/:id', () => {
  let vehicle;

  beforeEach(async () => {
    vehicle = await Vehicle.create({
      listingId: transportListing.id,
      type: 'voiture',
      brand: 'Renault',
      seats: 5,
      pricePerDay: 100,
      isAvailable: true,
    });
  });

  test('refuse la modification par un non-proprietaire (403)', async () => {
    const res = await request(app)
      .patch(`/api/vehicles/${vehicle.id}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ pricePerDay: 150 });

    expect(res.status).toBe(403);
  });

  test('modifie les champs du vehicule', async () => {
    const res = await request(app)
      .patch(`/api/vehicles/${vehicle.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        pricePerDay: 150,
        pricePerHour: 20,
        seats: 7,
        doors: 3,
        luggage: 2,
        transmission: 'manuelle',
        hasDecoration: true,
        perksTitle: 'Nos petits plus',
      });

    expect(res.status).toBe(200);
    expect(Number(res.body.pricePerDay)).toBe(150);
    expect(Number(res.body.pricePerHour)).toBe(20);
    expect(res.body.seats).toBe(7);
    expect(res.body.doors).toBe(3);
    expect(res.body.luggage).toBe(2);
    expect(res.body.transmission).toBe('manuelle');
    expect(res.body.hasDecoration).toBe(true);
    expect(res.body.perksTitle).toBe('Nos petits plus');
  });

  test('un tarif efface (chaine vide) devient NULL, jamais 0', async () => {
    vehicle.pricePerHour = 35;
    await vehicle.save();

    const res = await request(app)
      .patch(`/api/vehicles/${vehicle.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ pricePerHour: '' });

    expect(res.status).toBe(200);
    expect(res.body.pricePerHour).toBeNull();
    expect(Number(res.body.pricePerDay)).toBe(100);
  });

  test('retire le vehicule (soft delete, isAvailable=false)', async () => {
    const res = await request(app)
      .delete(`/api/vehicles/${vehicle.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    const updated = await Vehicle.findByPk(vehicle.id);
    expect(updated.isAvailable).toBe(false);
  });
});

describe('Modeles de decoration (POST/PATCH/DELETE)', () => {
  let vehicle;

  beforeEach(async () => {
    vehicle = await Vehicle.create({
      listingId: transportListing.id,
      type: 'voiture',
      brand: 'Seat',
      seats: 5,
      hasDecoration: true,
      isAvailable: true,
    });
  });

  test("refuse l'ajout d'un modele par un non-proprietaire (403)", async () => {
    const res = await request(app)
      .post(`/api/vehicles/${vehicle.id}/decorations`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .field('name', 'Fleurs blanches');

    expect(res.status).toBe(403);
  });

  test('refuse un modele sans nom (400)', async () => {
    const res = await request(app)
      .post(`/api/vehicles/${vehicle.id}/decorations`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('price', '80');

    expect(res.status).toBe(400);
  });

  test('ajoute un modele de decoration avec photo (201)', async () => {
    const res = await request(app)
      .post(`/api/vehicles/${vehicle.id}/decorations`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .field('name', 'Fleurs blanches et rubans satin')
      .field('description', 'Bouquet de fleurs blanches sur le capot, rubans satin')
      .field('price', '80')
      .attach('image', FAKE_JPEG, 'decoration.jpg');

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Fleurs blanches et rubans satin');
    expect(Number(res.body.price)).toBe(80);
    expect(res.body.imageUrl).toMatch(/^\/uploads\/listings\//);
    expect(res.body.isAvailable).toBe(true);
  });

  test('la flotte publique renvoie les modeles de decoration actifs du vehicule', async () => {
    await VehicleDecoration.create({ vehicleId: vehicle.id, name: 'Rubans rouges', price: 50 });

    const res = await request(app).get(`/api/listings/${transportListing.id}/vehicles`);
    expect(res.status).toBe(200);
    const found = res.body.find((v) => v.id === vehicle.id);
    expect(found.decorations.some((d) => d.name === 'Rubans rouges')).toBe(true);
  });

  test('modifie et retire (soft delete) un modele de decoration', async () => {
    const decoration = await VehicleDecoration.create({
      vehicleId: vehicle.id,
      name: 'Chic doré',
      price: 100,
    });

    const updateRes = await request(app)
      .patch(`/api/vehicle-decorations/${decoration.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ price: 120 });
    expect(updateRes.status).toBe(200);
    expect(Number(updateRes.body.price)).toBe(120);

    const deleteRes = await request(app)
      .delete(`/api/vehicle-decorations/${decoration.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);
    expect(deleteRes.status).toBe(200);

    const updated = await VehicleDecoration.findByPk(decoration.id);
    expect(updated.isAvailable).toBe(false);
  });
});

describe('POST /api/vehicles/:id/bookings (locations)', () => {
  let vehicle;

  beforeEach(async () => {
    vehicle = await Vehicle.create({
      listingId: transportListing.id,
      type: 'voiture',
      brand: 'Peugeot',
      seats: 5,
      pricePerDay: 120,
      isAvailable: true,
    });
  });

  test('refuse retour <= depart (400)', async () => {
    const res = await request(app)
      .post(`/api/vehicles/${vehicle.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientName: 'Sami Client',
        departureDatetime: '2026-08-10T10:00:00.000Z',
        returnDatetime: '2026-08-10T08:00:00.000Z',
      });

    expect(res.status).toBe(400);
  });

  test('enregistre une location pour un nouveau client (201)', async () => {
    const res = await request(app)
      .post(`/api/vehicles/${vehicle.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientName: 'Sami Client',
        clientPhone: '+21620000055',
        departureDatetime: '2026-08-10T08:00:00.000Z',
        returnDatetime: '2026-08-12T18:00:00.000Z',
        totalPrice: 360,
        deposit: 100,
        paymentMethod: 'cash',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.client.name).toBe('Sami Client');
    expect(Number(res.body.deposit)).toBe(100);

    // Montant total + acompte declares (CRM) : recalcules a partir de cette
    // location (prestataires Transport, voir crmService.recalculateClientFinancials).
    const client = await Client.findByPk(res.body.clientId);
    expect(Number(client.totalAmount)).toBe(360);
    expect(Number(client.depositAmount)).toBe(100);
  });

  test('refuse une location qui chevauche une periode deja reservee (409)', async () => {
    await request(app)
      .post(`/api/vehicles/${vehicle.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientName: 'Premier Client',
        departureDatetime: '2026-09-01T08:00:00.000Z',
        returnDatetime: '2026-09-05T18:00:00.000Z',
      });

    const res = await request(app)
      .post(`/api/vehicles/${vehicle.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientName: 'Deuxieme Client',
        departureDatetime: '2026-09-03T08:00:00.000Z',
        returnDatetime: '2026-09-07T18:00:00.000Z',
      });

    expect(res.status).toBe(409);
  });

  test('autorise a nouveau la periode une fois la location precedente annulee', async () => {
    const first = await request(app)
      .post(`/api/vehicles/${vehicle.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientName: 'Client Annule',
        departureDatetime: '2026-10-01T08:00:00.000Z',
        returnDatetime: '2026-10-05T18:00:00.000Z',
        totalPrice: 400,
        deposit: 150,
      });
    expect(first.status).toBe(201);

    await request(app)
      .patch(`/api/vehicle_bookings/${first.body.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ status: 'cancelled' });

    // L'annulation retire cette location du cumul CRM du client.
    const cancelledClient = await Client.findByPk(first.body.clientId);
    expect(Number(cancelledClient.totalAmount)).toBe(0);
    expect(Number(cancelledClient.depositAmount)).toBe(0);

    const second = await request(app)
      .post(`/api/vehicles/${vehicle.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        clientName: 'Nouveau Client',
        departureDatetime: '2026-10-02T08:00:00.000Z',
        returnDatetime: '2026-10-04T18:00:00.000Z',
      });

    expect(second.status).toBe(201);
  });

  test('cree une location depuis un lead et le passe converti', async () => {
    const lead = await Lead.create({
      listingId: transportListing.id,
      firstName: 'Amina',
      lastName: 'Cliente',
      email: 'amina.lead.vehicles.test@example.com',
      phone: '+21620000066',
      status: 'new',
    });

    const res = await request(app)
      .post(`/api/vehicles/${vehicle.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        leadId: lead.id,
        departureDatetime: '2026-11-01T08:00:00.000Z',
        returnDatetime: '2026-11-03T18:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.lead.id).toBe(lead.id);

    const updatedLead = await Lead.findByPk(lead.id);
    expect(updatedLead.status).toBe('converted');
  });

  test("refuse la consultation des locations par un non-proprietaire (403)", async () => {
    const res = await request(app)
      .get(`/api/vehicles/${vehicle.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);

    expect(res.status).toBe(403);
  });

  test('liste les locations du vehicule pour le proprietaire', async () => {
    const res = await request(app)
      .get(`/api/vehicles/${vehicle.id}/bookings`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('PATCH /api/vehicle_bookings/:id/status', () => {
  test('modifie le statut de la location', async () => {
    const vehicle = await Vehicle.create({
      listingId: transportListing.id,
      type: 'minibus',
      seats: 12,
      isAvailable: true,
    });
    const booking = await VehicleBooking.create({
      vehicleId: vehicle.id,
      listingId: transportListing.id,
      departureDatetime: '2026-12-01T08:00:00.000Z',
      returnDatetime: '2026-12-03T18:00:00.000Z',
      status: 'pending',
    });

    const res = await request(app)
      .patch(`/api/vehicle_bookings/${booking.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });
});

describe('PATCH /api/vehicle_bookings/:id (edition complete)', () => {
  let vehicle;

  beforeEach(async () => {
    vehicle = await Vehicle.create({
      listingId: transportListing.id,
      type: 'voiture',
      brand: 'Toyota',
      seats: 5,
      isAvailable: true,
    });
  });

  test("refuse la modification par un non-proprietaire (403)", async () => {
    const booking = await VehicleBooking.create({
      vehicleId: vehicle.id,
      listingId: transportListing.id,
      departureDatetime: '2027-04-01T08:00:00.000Z',
      returnDatetime: '2027-04-03T18:00:00.000Z',
      status: 'confirmed',
    });

    const res = await request(app)
      .patch(`/api/vehicle_bookings/${booking.id}`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ totalPrice: 200 });

    expect(res.status).toBe(403);
  });

  test('modifie les dates, le montant et le statut', async () => {
    const booking = await VehicleBooking.create({
      vehicleId: vehicle.id,
      listingId: transportListing.id,
      departureDatetime: '2027-04-10T08:00:00.000Z',
      returnDatetime: '2027-04-12T18:00:00.000Z',
      totalPrice: 200,
      status: 'pending',
    });

    const res = await request(app)
      .patch(`/api/vehicle_bookings/${booking.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({
        departureDatetime: '2027-04-11T08:00:00.000Z',
        returnDatetime: '2027-04-13T18:00:00.000Z',
        totalPrice: 250,
        deposit: 50,
        status: 'confirmed',
      });

    expect(res.status).toBe(200);
    expect(Number(res.body.totalPrice)).toBe(250);
    expect(Number(res.body.deposit)).toBe(50);
    expect(res.body.status).toBe('confirmed');
    expect(new Date(res.body.departureDatetime).toISOString()).toBe('2027-04-11T08:00:00.000Z');
  });

  test('refuse une modification qui chevaucherait une autre location du meme vehicule (409)', async () => {
    await VehicleBooking.create({
      vehicleId: vehicle.id,
      listingId: transportListing.id,
      departureDatetime: '2027-05-10T08:00:00.000Z',
      returnDatetime: '2027-05-12T18:00:00.000Z',
      status: 'confirmed',
    });
    const booking = await VehicleBooking.create({
      vehicleId: vehicle.id,
      listingId: transportListing.id,
      departureDatetime: '2027-06-01T08:00:00.000Z',
      returnDatetime: '2027-06-03T18:00:00.000Z',
      status: 'confirmed',
    });

    const res = await request(app)
      .patch(`/api/vehicle_bookings/${booking.id}`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ departureDatetime: '2027-05-11T08:00:00.000Z' });

    expect(res.status).toBe(409);
  });
});

describe('GET /api/listings/:id/vehicle-bookings (reservations Transport, tous vehicules)', () => {
  test("refuse l'acces a un prestataire qui n'est pas proprietaire (403)", async () => {
    const res = await request(app)
      .get(`/api/listings/${transportListing.id}/vehicle-bookings`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);

    expect(res.status).toBe(403);
  });

  test('liste les reservations avec les champs du lead associe (passagers/chauffeur/decoration)', async () => {
    const vehicle = await Vehicle.create({
      listingId: transportListing.id,
      type: 'voiture',
      brand: 'Renault',
      model: 'Clio',
      seats: 5,
      pricePerDay: 100,
      isAvailable: true,
    });
    const decoration = await VehicleDecoration.create({
      vehicleId: vehicle.id,
      name: 'Fleurs blanches',
      price: 50,
      isAvailable: true,
    });
    const lead = await Lead.create({
      listingId: transportListing.id,
      firstName: 'Nour',
      lastName: 'Cliente',
      email: 'nour.lead.vehicles.test@example.com',
      phone: '+21620000077',
      status: 'new',
      passengers: 4,
      withDriver: true,
      vehicleId: vehicle.id,
      decorationId: decoration.id,
      departureDatetime: '2027-01-01T08:00:00.000Z',
      returnDatetime: '2027-01-03T18:00:00.000Z',
    });
    await VehicleBooking.create({
      vehicleId: vehicle.id,
      listingId: transportListing.id,
      leadId: lead.id,
      departureDatetime: '2027-01-01T08:00:00.000Z',
      returnDatetime: '2027-01-03T18:00:00.000Z',
      totalPrice: 250,
      status: 'confirmed',
    });

    const res = await request(app)
      .get(`/api/listings/${transportListing.id}/vehicle-bookings`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    const found = res.body.find((b) => b.leadId === lead.id);
    expect(found).toBeDefined();
    expect(found.vehicle.brand).toBe('Renault');
    expect(found.lead.passengers).toBe(4);
    expect(found.lead.withDriver).toBe(true);
    expect(found.lead.decoration.name).toBe('Fleurs blanches');
  });
});

describe('GET /api/listings/:id/availability (calendrier bloque par les locations)', () => {
  test('chaque jour couvert par une location active apparait comme reserve', async () => {
    const vehicle = await Vehicle.create({
      listingId: transportListing.id,
      type: 'voiture',
      brand: 'Kia',
      model: 'Picanto',
      seats: 4,
      isAvailable: true,
    });
    await VehicleBooking.create({
      vehicleId: vehicle.id,
      listingId: transportListing.id,
      departureDatetime: '2027-02-10T08:00:00.000Z',
      returnDatetime: '2027-02-12T18:00:00.000Z',
      status: 'confirmed',
    });

    const res = await request(app).get(`/api/listings/${transportListing.id}/availability`);

    expect(res.status).toBe(200);
    const reservedDates = res.body.filter((e) => e.source === 'booking').map((e) => e.date);
    expect(reservedDates).toEqual(expect.arrayContaining(['2027-02-10', '2027-02-11', '2027-02-12']));
  });

  test('une location annulee ne bloque plus le calendrier', async () => {
    const vehicle = await Vehicle.create({
      listingId: transportListing.id,
      type: 'voiture',
      brand: 'Dacia',
      model: 'Sandero',
      seats: 5,
      isAvailable: true,
    });
    const booking = await VehicleBooking.create({
      vehicleId: vehicle.id,
      listingId: transportListing.id,
      departureDatetime: '2027-03-05T08:00:00.000Z',
      returnDatetime: '2027-03-06T18:00:00.000Z',
      status: 'cancelled',
    });

    const res = await request(app).get(`/api/listings/${transportListing.id}/availability`);

    expect(res.status).toBe(200);
    const reservedDates = res.body.filter((e) => e.source === 'booking').map((e) => e.date);
    expect(reservedDates).not.toContain('2027-03-05');
    expect(booking.status).toBe('cancelled');
  });
});

describe('GET /api/listings (filtres flotte Transport)', () => {
  test('filtre par nombre de places minimum', async () => {
    await Vehicle.create({
      listingId: transportListing.id,
      type: 'bus',
      seats: 45,
      isAvailable: true,
    });

    const res = await request(app).get('/api/listings').query({ minSeats: 40 });
    expect(res.status).toBe(200);
    expect(res.body.results.some((l) => l.id === transportListing.id)).toBe(true);
    expect(res.body.results.some((l) => l.id === nonTransportListing.id)).toBe(false);
  });

  test('filtre par type de vehicule', async () => {
    const res = await request(app).get('/api/listings').query({ vehicleType: 'minibus' });
    expect(res.status).toBe(200);
    // Un minibus a ete cree plus haut sur transportListing (test statut).
    expect(res.body.results.some((l) => l.id === transportListing.id)).toBe(true);
  });

  test('ne renvoie rien pour un type absent de toute flotte', async () => {
    const res = await request(app).get('/api/listings').query({ vehicleType: 'bus', minSeats: 999 });
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(0);
  });
});
