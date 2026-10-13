process.env.DATABASE_URL = '';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'root';
process.env.DB_PASS = process.env.DB_PASS || '';
process.env.DB_NAME = 'farahbooking_test';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_EXPIRES_IN = '1h';
process.env.JWT_REFRESH_SECRET = 'test_jwt_refresh_secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/models');
const app = require('../src/app');
const leadCronService = require('../src/services/leadCronService');

const {
  Category,
  User,
  Listing,
  Lead,
  Booking,
  Vehicle,
  VehicleDecoration,
  VehicleBooking,
  VehicleOption,
  ProviderEvent,
  Package,
} = db;

let category;
let providerUser;
let otherProviderUser;
let clientUser;
let listing;
let transportCategory;
let carsSubCategory;
let transportListing;
let vehicle;
let decorationModel;
let gpsOption;
let childSeatOption;
let otherTransportListing;
let otherVehicle;
let publishedEvent;
let draftEvent;
let otherListingEvent;
let productCategory;
let productListing;
let musc;
let otherProductListing;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  category = await Category.create({ name: 'DJ', slug: 'dj-leads-test' });

  providerUser = await User.create({
    role: 'provider',
    firstName: 'Karim',
    lastName: 'Mzoughi',
    email: 'provider.leads.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  otherProviderUser = await User.create({
    role: 'provider',
    firstName: 'Autre',
    lastName: 'Prestataire',
    email: 'other.provider.leads.test@example.com',
    passwordHash: 'hash',
    emailVerified: true,
  });

  clientUser = await User.create({
    role: 'client',
    firstName: 'Amina',
    lastName: 'Client',
    email: 'client.leads.test@example.com',
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

  // Le controleur verifie le slug litteral 'transport' (celui du seed reel).
  transportCategory = await Category.create({ name: 'Transport', slug: 'transport' });
  carsSubCategory = await Category.create({
    name: 'Location de voitures',
    slug: 'location-voitures-leads-test',
    parentId: transportCategory.id,
  });

  transportListing = await Listing.create({
    userId: providerUser.id,
    categoryId: carsSubCategory.id,
    title: 'Karim Location Auto',
    city: 'Tunis',
    status: 'active',
  });
  vehicle = await Vehicle.create({
    listingId: transportListing.id,
    type: 'voiture',
    brand: 'Mercedes',
    seats: 4,
    hasDecoration: true,
    isAvailable: true,
  });
  decorationModel = await VehicleDecoration.create({
    vehicleId: vehicle.id,
    name: 'Fleurs blanches',
    price: 80,
  });
  gpsOption = await VehicleOption.create({
    vehicleId: vehicle.id,
    name: 'GPS',
    price: 2,
    pricingType: 'per_day',
    maxQuantity: 1,
  });
  childSeatOption = await VehicleOption.create({
    vehicleId: vehicle.id,
    name: 'Siège enfant',
    price: 1,
    pricingType: 'per_day',
    maxQuantity: 2,
  });

  otherTransportListing = await Listing.create({
    userId: otherProviderUser.id,
    categoryId: carsSubCategory.id,
    title: 'Autre Location Auto',
    city: 'Sousse',
    status: 'active',
  });
  otherVehicle = await Vehicle.create({
    listingId: otherTransportListing.id,
    type: 'bus',
    seats: 40,
    isAvailable: true,
  });

  // Le controleur verifie le slug litteral 'parfums-soins' (celui du seed reel).
  productCategory = await Category.create({ name: 'Parfums & Soins', slug: 'parfums-soins' });
  productListing = await Listing.create({
    userId: providerUser.id,
    categoryId: productCategory.id,
    title: 'Essences de Carthage',
    city: 'Sfax',
    status: 'active',
  });
  musc = await Package.create({
    listingId: productListing.id,
    name: 'Coffret Musc Blanc',
    price: 45,
    priceType: 'fixed',
  });
  otherProductListing = await Listing.create({
    userId: otherProviderUser.id,
    categoryId: productCategory.id,
    title: 'Autre Parfumeur',
    city: 'Tunis',
    status: 'active',
  });

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 15);
  const futureDateStr = futureDate.toISOString().slice(0, 10);

  publishedEvent = await ProviderEvent.create({
    listingId: listing.id,
    title: 'Journée portes ouvertes',
    eventDate: futureDateStr,
    isPublished: true,
  });
  draftEvent = await ProviderEvent.create({
    listingId: listing.id,
    title: 'Show cooking (brouillon)',
    eventDate: futureDateStr,
    isPublished: false,
  });
  otherListingEvent = await ProviderEvent.create({
    listingId: otherTransportListing.id,
    title: "Événement d'un autre prestataire",
    eventDate: futureDateStr,
    isPublished: true,
  });
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('POST /api/leads', () => {
  const validPayload = {
    firstName: 'Sami',
    lastName: 'Trabelsi',
    email: 'sami.trabelsi@example.com',
    phone: '+21620000099',
    guests: '100-150',
    message: 'Bonjour, disponible pour le 10 mai ?',
  };

  test('cree un lead en visiteur anonyme et renvoie 201', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({ ...validPayload, listingId: listing.id });

    expect(res.status).toBe(201);
    expect(res.body.lead.status).toBe('new');
    expect(res.body.lead.userId).toBeNull();
  });

  test('rejette un prestataire authentifie avec 403', async () => {
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ ...validPayload, email: 'sami2@example.com', listingId: listing.id });

    expect(res.status).toBe(403);
  });

  test('rejette une fiche prestataire inexistante avec 404', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({ ...validPayload, email: 'sami3@example.com', listingId: 999999 });

    expect(res.status).toBe(404);
  });

  test('bloque un doublon (meme email + meme fiche) sous 10 minutes avec 429', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({ ...validPayload, listingId: listing.id });

    expect(res.status).toBe(429);
  });

  test('associe le lead au client connecte quand authentifie', async () => {
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenFor(clientUser)}`)
      .send({ ...validPayload, email: 'amina.lead@example.com', listingId: listing.id });

    expect(res.status).toBe(201);
    expect(res.body.lead.userId).toBe(clientUser.id);
  });
});

describe("POST /api/leads (demande d'intérêt - événement prestataire)", () => {
  test("cree une demande d'interet rattachee a un evenement publie (201)", async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        firstName: 'Yasmine',
        lastName: 'Kort',
        email: 'yasmine.event1@example.com',
        phone: '+21620000301',
        listingId: listing.id,
        providerEventId: publishedEvent.id,
        message: `Intéressé(e) par l'événement : ${publishedEvent.title}`,
      });

    expect(res.status).toBe(201);
    expect(res.body.lead.providerEventId).toBe(publishedEvent.id);
    expect(res.body.lead.eventDate).toBeNull();
  });

  test("refuse un evenement en brouillon (non publie) avec 400", async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        firstName: 'Yasmine',
        lastName: 'Kort',
        email: 'yasmine.event2@example.com',
        phone: '+21620000302',
        listingId: listing.id,
        providerEventId: draftEvent.id,
      });

    expect(res.status).toBe(400);
  });

  test("refuse un evenement appartenant a un autre prestataire avec 400", async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        firstName: 'Yasmine',
        lastName: 'Kort',
        email: 'yasmine.event3@example.com',
        phone: '+21620000303',
        listingId: listing.id,
        providerEventId: otherListingEvent.id,
      });

    expect(res.status).toBe(400);
  });

  test('ignore un providerEventId absent (demande de devis classique)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        firstName: 'Yasmine',
        lastName: 'Kort',
        email: 'yasmine.event4@example.com',
        phone: '+21620000304',
        listingId: listing.id,
        guests: '50-100',
      });

    expect(res.status).toBe(201);
    expect(res.body.lead.providerEventId).toBeNull();
  });
});

describe("Séparation demandes de devis / demandes d'intérêt événement", () => {
  test("une demande d'interet evenement n'apparait pas dans GET /api/listings/:id/leads (devis)", async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/leads`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.leads.some((lead) => lead.email === 'yasmine.event1@example.com')).toBe(false);
  });

  test("refuse GET /api/listings/:id/events/leads a un non-proprietaire (403)", async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/events/leads`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);

    expect(res.status).toBe(403);
  });

  test('GET /api/listings/:id/events/leads renvoie uniquement les demandes liees a un evenement', async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/events/leads`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.stats.total).toBe(res.body.leads.length);
    const found = res.body.leads.find((lead) => lead.email === 'yasmine.event1@example.com');
    expect(found).toBeDefined();
    expect(found.interestedEvent.title).toBe(publishedEvent.title);
    expect(res.body.leads.every((lead) => lead.providerEventId !== null)).toBe(true);
  });
});

describe('POST /api/leads (demande de location - prestataires Transport)', () => {
  const basePayload = {
    firstName: 'Sami',
    lastName: 'Trabelsi',
    phone: '+21620000199',
  };

  test('cree une demande de location avec les champs transport (201)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'sami.transport1@example.com',
        listingId: transportListing.id,
        departureDatetime: '2030-09-01T08:00:00.000Z',
        returnDatetime: '2030-09-03T18:00:00.000Z',
        passengers: 3,
        vehicleId: vehicle.id,
        withDriver: true,
        decorationId: decorationModel.id,
        pickupLocation: 'Aéroport Tunis-Carthage',
      });

    expect(res.status).toBe(201);
    expect(res.body.lead.passengers).toBe(3);
    expect(res.body.lead.vehicleId).toBe(vehicle.id);
    expect(res.body.lead.withDriver).toBe(true);
    expect(res.body.lead.decorationId).toBe(decorationModel.id);
    expect(res.body.lead.pickupLocation).toBe('Aéroport Tunis-Carthage');
    expect(new Date(res.body.lead.departureDatetime).toISOString()).toBe('2030-09-01T08:00:00.000Z');
  });

  test('refuse une date de retour anterieure ou egale au depart (400)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'sami.transport2@example.com',
        listingId: transportListing.id,
        departureDatetime: '2030-09-10T08:00:00.000Z',
        returnDatetime: '2030-09-10T08:00:00.000Z',
        passengers: 2,
      });

    expect(res.status).toBe(400);
  });

  test('refuse un nombre de passagers invalide (400)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'sami.transport3@example.com',
        listingId: transportListing.id,
        departureDatetime: '2030-09-10T08:00:00.000Z',
        returnDatetime: '2030-09-12T08:00:00.000Z',
        passengers: 0,
      });

    expect(res.status).toBe(400);
  });

  test("refuse un vehicule qui n'appartient pas a ce prestataire (400)", async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'sami.transport4@example.com',
        listingId: transportListing.id,
        departureDatetime: '2030-09-15T08:00:00.000Z',
        returnDatetime: '2030-09-17T08:00:00.000Z',
        passengers: 2,
        vehicleId: otherVehicle.id,
      });

    expect(res.status).toBe(400);
  });

  test('ignore les champs transport envoyes pour une fiche hors categorie Transport', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'sami.transport5@example.com',
        listingId: listing.id,
        guests: '1-50',
        departureDatetime: '2030-09-20T08:00:00.000Z',
        returnDatetime: '2030-09-22T08:00:00.000Z',
        passengers: 4,
      });

    expect(res.status).toBe(201);
    expect(res.body.lead.departureDatetime).toBeNull();
    expect(res.body.lead.passengers).toBeNull();
    expect(res.body.lead.decorationId).toBeNull();
  });

  test("refuse un modele de decoration qui n'appartient pas au vehicule choisi (400)", async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'sami.transport6@example.com',
        listingId: transportListing.id,
        departureDatetime: '2030-09-25T08:00:00.000Z',
        returnDatetime: '2030-09-27T08:00:00.000Z',
        passengers: 2,
        vehicleId: vehicle.id,
        decorationId: 999999,
      });

    expect(res.status).toBe(400);
  });

  test('cree une demande avec des options supplementaires (201)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'sami.transport-options1@example.com',
        listingId: transportListing.id,
        departureDatetime: '2030-09-28T08:00:00.000Z',
        returnDatetime: '2030-09-30T08:00:00.000Z',
        passengers: 2,
        vehicleId: vehicle.id,
        options: [
          { vehicleOptionId: gpsOption.id, quantity: 1 },
          { vehicleOptionId: childSeatOption.id, quantity: 2 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.lead.selectedOptions).toHaveLength(2);
    const childSeatSelection = res.body.lead.selectedOptions.find(
      (s) => s.vehicleOptionId === childSeatOption.id
    );
    expect(childSeatSelection.quantity).toBe(2);
  });

  test("refuse une option qui n'appartient pas au vehicule choisi (400)", async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'sami.transport-options2@example.com',
        listingId: transportListing.id,
        departureDatetime: '2030-09-28T08:00:00.000Z',
        returnDatetime: '2030-09-30T08:00:00.000Z',
        passengers: 2,
        vehicleId: vehicle.id,
        options: [{ vehicleOptionId: 999999, quantity: 1 }],
      });

    expect(res.status).toBe(400);
  });

  test('refuse une quantite superieure au maximum autorise pour une option (400)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'sami.transport-options3@example.com',
        listingId: transportListing.id,
        departureDatetime: '2030-09-28T08:00:00.000Z',
        returnDatetime: '2030-09-30T08:00:00.000Z',
        passengers: 2,
        vehicleId: vehicle.id,
        options: [{ vehicleOptionId: childSeatOption.id, quantity: 5 }],
      });

    expect(res.status).toBe(400);
  });

  test('bloque une demande qui chevauche une location deja active pour ce vehicule (409)', async () => {
    await VehicleBooking.create({
      vehicleId: vehicle.id,
      listingId: transportListing.id,
      departureDatetime: '2030-10-01T08:00:00.000Z',
      returnDatetime: '2030-10-05T08:00:00.000Z',
      status: 'confirmed',
    });

    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'sami.transport7@example.com',
        listingId: transportListing.id,
        departureDatetime: '2030-10-03T08:00:00.000Z',
        returnDatetime: '2030-10-04T08:00:00.000Z',
        passengers: 2,
        vehicleId: vehicle.id,
      });

    expect(res.status).toBe(409);
  });

  test('GET /api/vehicles/:id/reserved-periods expose les periodes actives sans donnees client', async () => {
    const res = await request(app).get(`/api/vehicles/${vehicle.id}/reserved-periods`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(
      res.body.some(
        (p) => new Date(p.departureDatetime).toISOString() === '2030-10-01T08:00:00.000Z'
      )
    ).toBe(true);
    expect(res.body[0].client).toBeUndefined();
  });
});

describe('POST /api/leads (commande produit - prestataires Parfums & Soins)', () => {
  const basePayload = {
    firstName: 'Ines',
    lastName: 'Bouzid',
    phone: '+21620000399',
  };

  test('cree une demande produit avec les champs quantite/livraison (201)', async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 10);
    const deliveryDate = futureDate.toISOString().slice(0, 10);

    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'ines.product1@example.com',
        listingId: productListing.id,
        packageId: musc.id,
        quantity: 25,
        deliveryDate,
        deliveryMode: 'livraison',
        deliveryAddress: '12 rue de la Liberté, Sfax',
        customization: 'Étiquette dorée avec les prénoms des mariés',
      });

    expect(res.status).toBe(201);
    expect(res.body.lead.quantity).toBe(25);
    expect(res.body.lead.deliveryMode).toBe('livraison');
    expect(res.body.lead.deliveryAddress).toBe('12 rue de la Liberté, Sfax');
    expect(res.body.lead.packageId).toBe(musc.id);
    expect(res.body.lead.package.name).toBe('Coffret Musc Blanc');
    expect(res.body.lead.eventDate).toBeNull();
  });

  test('accepte une demande en mode retrait sans adresse (201)', async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 5);

    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'ines.product2@example.com',
        listingId: productListing.id,
        quantity: 10,
        deliveryDate: futureDate.toISOString().slice(0, 10),
        deliveryMode: 'retrait',
      });

    expect(res.status).toBe(201);
    expect(res.body.lead.deliveryMode).toBe('retrait');
    expect(res.body.lead.deliveryAddress).toBeNull();
    expect(res.body.lead.packageId).toBeNull();
  });

  test('refuse une quantite invalide - zero (400)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'ines.product3@example.com',
        listingId: productListing.id,
        quantity: 0,
        deliveryMode: 'retrait',
      });

    expect(res.status).toBe(400);
  });

  test('refuse une date de livraison dans le passe (400)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'ines.product4@example.com',
        listingId: productListing.id,
        quantity: 5,
        deliveryDate: '2020-01-01',
        deliveryMode: 'retrait',
      });

    expect(res.status).toBe(400);
  });

  test('refuse le mode livraison sans adresse de livraison (400)', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'ines.product5@example.com',
        listingId: productListing.id,
        quantity: 5,
        deliveryMode: 'livraison',
      });

    expect(res.status).toBe(400);
  });

  test("refuse un produit qui n'appartient pas a ce prestataire (400)", async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'ines.product6@example.com',
        listingId: otherProductListing.id,
        packageId: musc.id,
        quantity: 5,
        deliveryMode: 'retrait',
      });

    expect(res.status).toBe(400);
  });

  test('ignore les champs produit envoyes pour une fiche hors categorie Parfums & Soins', async () => {
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'ines.product7@example.com',
        listingId: listing.id,
        guests: '1-50',
        quantity: 12,
        deliveryMode: 'livraison',
        deliveryAddress: 'Une adresse quelconque',
      });

    expect(res.status).toBe(201);
    expect(res.body.lead.quantity).toBeNull();
    expect(res.body.lead.deliveryMode).toBeNull();
    expect(res.body.lead.deliveryAddress).toBeNull();
  });

  test('formulaire evenementiel standard (guests requis) accepte toujours une chaine quantity vide envoyee par erreur', async () => {
    // Le formulaire standard (ContactForm) envoie tous les champs du form,
    // y compris les champs produit en chaine vide pour une categorie non
    // "Parfums & Soins" - ne doit jamais etre rejete comme "quantite invalide".
    const res = await request(app)
      .post('/api/leads')
      .send({
        ...basePayload,
        email: 'ines.product8@example.com',
        listingId: listing.id,
        guests: '1-50',
        quantity: '',
        deliveryDate: '',
        deliveryMode: '',
        deliveryAddress: '',
        packageId: '',
        customization: '',
      });

    expect(res.status).toBe(201);
  });
});

describe('GET /api/listings/:id/leads (demandes produit - Parfums & Soins)', () => {
  test('renvoie les champs produit (quantite, livraison, personnalisation) au prestataire proprietaire', async () => {
    const res = await request(app)
      .get(`/api/listings/${productListing.id}/leads`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    const found = res.body.leads.find((lead) => lead.email === 'ines.product1@example.com');
    expect(found).toBeDefined();
    expect(found.quantity).toBe(25);
    expect(found.deliveryMode).toBe('livraison');
    expect(found.package.name).toBe('Coffret Musc Blanc');
  });
});

describe('GET /api/leads/me', () => {
  test("renvoie les demandes du client connecte", async () => {
    const res = await request(app)
      .get('/api/leads/me')
      .set('Authorization', `Bearer ${tokenFor(clientUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    res.body.forEach((lead) => expect(lead.userId).toBe(clientUser.id));
  });
});

describe('GET /api/listings/:id/leads', () => {
  test('refuse l\'acces a un prestataire qui n\'est pas proprietaire (403)', async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/leads`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`);

    expect(res.status).toBe(403);
  });

  test('renvoie les leads et les stats au proprietaire de la fiche', async () => {
    const res = await request(app)
      .get(`/api/listings/${listing.id}/leads`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.leads.length).toBeGreaterThan(0);
    expect(res.body.stats).toHaveProperty('responseRate');
  });
});

describe('PATCH /api/leads/:id/status', () => {
  test('refuse un statut non autorise (400)', async () => {
    const lead = await Lead.findOne({ where: { listingId: listing.id } });
    const res = await request(app)
      .patch(`/api/leads/${lead.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ status: 'new' });

    expect(res.status).toBe(400);
  });

  test("refuse un prestataire non proprietaire (403)", async () => {
    const lead = await Lead.findOne({ where: { listingId: listing.id } });
    const res = await request(app)
      .patch(`/api/leads/${lead.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(otherProviderUser)}`)
      .send({ status: 'answered' });

    expect(res.status).toBe(403);
  });

  test('le proprietaire peut passer un lead a "converted" et cree un booking', async () => {
    const lead = await Lead.findOne({ where: { listingId: listing.id } });

    const res = await request(app)
      .patch(`/api/leads/${lead.id}/status`)
      .set('Authorization', `Bearer ${tokenFor(providerUser)}`)
      .send({ status: 'converted' });

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('converted');
    expect(res.body.lead.answeredAt).not.toBeNull();

    const booking = await Booking.findOne({ where: { leadId: lead.id } });
    expect(booking).not.toBeNull();
    expect(booking.status).toBe('confirmed');
  });
});

describe('leadCronService.markLateLeads', () => {
  test("fait passer un lead 'new' de plus de 48h en 'late'", async () => {
    const oldLead = await Lead.create({
      listingId: listing.id,
      firstName: 'Vieux',
      lastName: 'Lead',
      email: 'vieux.lead@example.com',
      phone: '+21620000098',
      status: 'new',
    });
    await Lead.update(
      { createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
      { where: { id: oldLead.id }, silent: true }
    );

    await leadCronService.markLateLeads();

    const refreshed = await Lead.findByPk(oldLead.id);
    expect(refreshed.status).toBe('late');
  });

  test("ne touche pas un lead 'new' recent", async () => {
    const recentLead = await Lead.create({
      listingId: listing.id,
      firstName: 'Recent',
      lastName: 'Lead',
      email: 'recent.lead@example.com',
      phone: '+21620000097',
      status: 'new',
    });

    await leadCronService.markLateLeads();

    const refreshed = await Lead.findByPk(recentLead.id);
    expect(refreshed.status).toBe('new');
  });
});
