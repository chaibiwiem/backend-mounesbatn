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
const { sendDueReviewInvites } = require('../src/services/commissionCronService');

const { Category, User, Listing, Lead, Commission, Booking, CommissionInvoice } = db;

let venues;
let provider;
let otherProvider;
let superAdmin;
let moderator;
let analyst;
let listing;
let otherListing;
let djListing;

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role, adminRole: user.adminRole || null }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
}
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });

function dateFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
const currentMonth = () => new Date().toISOString().slice(0, 7);

async function createLead(listingId, email, extra = {}) {
  const res = await request(app)
    .post('/api/leads')
    .send({
      listingId,
      firstName: 'Ines',
      lastName: 'Cliente',
      email,
      phone: '+21620123456',
      eventDate: dateFromToday(40),
      guests: '100-150',
      ...extra,
    });
  expect(res.status).toBe(201);
  return res.body.lead;
}

const confirm = (lead, user = provider, body = {}) =>
  request(app)
    .post(`/api/leads/${lead.id}/confirm`)
    .set(auth(user))
    .send({ eventDate: dateFromToday(40), fromMounesba: true, ...body });

async function makeUser(role, email, adminRole = null) {
  return User.create({
    role,
    adminRole,
    firstName: 'Test',
    lastName: role,
    email,
    passwordHash: 'hash',
    emailVerified: true,
  });
}

beforeAll(async () => {
  await db.sequelize.sync({ force: true });

  // "Lieux de mariage" active pour toutes ses sous-categories (forfait 300 DT).
  venues = await Category.create({
    name: 'Lieux de mariage',
    slug: 'lieux-de-mariage',
    commissionEnabled: true,
    commissionType: 'fixed',
    commissionValue: 300,
  });
  const halls = await Category.create({ name: 'Salles des fêtes', slug: 'salles-de-fetes', parentId: venues.id });
  const animation = await Category.create({ name: 'Animation', slug: 'animation' });
  const dj = await Category.create({ name: 'DJ', slug: 'dj', parentId: animation.id });

  provider = await makeUser('provider', 'fees.provider@example.com');
  otherProvider = await makeUser('provider', 'fees.other@example.com');
  const djProvider = await makeUser('provider', 'fees.dj@example.com');
  superAdmin = await makeUser('admin', 'fees.admin@example.com', 'super_admin');
  moderator = await makeUser('admin', 'fees.moderator@example.com', 'moderator');
  analyst = await makeUser('admin', 'fees.analyst@example.com', 'analyst');

  listing = await Listing.create({
    userId: provider.id,
    categoryId: halls.id,
    title: 'Salle Yasmine',
    city: 'Tunis',
    status: 'active',
  });
  otherListing = await Listing.create({
    userId: otherProvider.id,
    categoryId: halls.id,
    title: 'Salle Autre',
    city: 'Sousse',
    status: 'active',
    connectionFeeTermsAcceptedAt: new Date(),
    connectionFeeTermsVersion: '2026-10-v1',
  });
  djListing = await Listing.create({
    userId: djProvider.id,
    categoryId: dj.id,
    title: 'DJ Hors Frais',
    city: 'Tunis',
    status: 'active',
  });
  djListing.ownerUser = djProvider;
});

afterAll(async () => {
  await db.sequelize.close();
});

describe('Categorie non concernee', () => {
  test("une demande aboutie hors categorie concernee ne cree aucun frais", async () => {
    const lead = await createLead(djListing.id, 'dj.client@example.com');

    const confirmRes = await confirm(lead, djListing.ownerUser);
    expect(confirmRes.status).toBe(400);

    // Passage "converti" classique : aucun frais non plus.
    const statusRes = await request(app)
      .patch(`/api/leads/${lead.id}/status`)
      .set(auth(djListing.ownerUser))
      .send({ status: 'converted' });
    expect(statusRes.status).toBe(200);
    expect(await Commission.count({ where: { leadId: lead.id } })).toBe(0);

    const commissions = await request(app).get(`/api/listings/${djListing.id}/commissions`).set(auth(djListing.ownerUser));
    expect(commissions.body.concerned).toBe(false);
  });
});

describe('Conditions de referencement', () => {
  test('sans acceptation des conditions, aucune confirmation possible (403)', async () => {
    const lead = await createLead(listing.id, 'terms.client@example.com');
    const res = await confirm(lead);
    expect(res.status).toBe(403);
    expect(res.body.termsRequired).toBe(true);
    expect(await Commission.count({ where: { leadId: lead.id } })).toBe(0);
  });

  test('le prestataire accepte : date et version enregistrees', async () => {
    const res = await request(app)
      .post('/api/listings/me/connection-fee-terms')
      .set(auth(provider))
      .send({ accept: true });
    expect(res.status).toBe(200);
    await listing.reload();
    expect(listing.connectionFeeTermsAcceptedAt).not.toBeNull();
    expect(listing.connectionFeeTermsVersion).toBe('2026-10-v1');
  });
});

describe('Double confirmation', () => {
  let lead;
  let commission;

  test('confirmation prestataire : ligne pending_admin, montant calcule cote serveur', async () => {
    lead = await createLead(listing.id, 'double.client@example.com');
    const res = await confirm(lead, provider, { declaredAmount: 12000, amount: 1, commissionValue: 1 });
    expect(res.status).toBe(201);
    commission = await Commission.findByPk(res.body.id);
    expect(commission.status).toBe('pending_admin');
    expect(commission.providerConfirmedAt).not.toBeNull();
    expect(Number(commission.amount)).toBe(300);
    expect(Number(commission.commissionValue)).toBe(300);
    expect(commission.commissionType).toBe('fixed');
    expect(Number(commission.declaredAmount)).toBe(12000);
    expect(commission.categoryId).toBe(venues.id);

    // La demande passe "convertie" et laisse une trace de reservation.
    expect((await Lead.findByPk(lead.id)).status).toBe('converted');
    expect(await Booking.count({ where: { leadId: lead.id } })).toBe(1);
  });

  test('confirmation obligatoirement explicite (fromMounesba)', async () => {
    const other = await createLead(listing.id, 'explicit.client@example.com');
    const res = await confirm(other, provider, { fromMounesba: false });
    expect(res.status).toBe(400);
  });

  test("une ligne pending_admin n'est jamais facturable", async () => {
    const res = await request(app)
      .post('/api/admin/commissions/invoice')
      .set(auth(superAdmin))
      .send({ month: currentMonth() });
    expect([200, 201]).toContain(res.status);
    expect(res.body.created.find((invoice) => invoice.listingId === listing.id)).toBeUndefined();
    expect((await Commission.findByPk(commission.id)).status).toBe('pending_admin');
  });

  test('la contrainte UNIQUE sur lead_id empeche tout doublon', async () => {
    const res = await confirm(lead);
    expect(res.status).toBe(409);
    await expect(
      Commission.create({
        leadId: lead.id,
        listingId: listing.id,
        categoryId: venues.id,
        commissionValue: 300,
        amount: 300,
        status: 'pending_admin',
      })
    ).rejects.toThrow();
    expect(await Commission.count({ where: { leadId: lead.id } })).toBe(1);
  });

  test("un analyste ne peut pas valider ; le moderateur valide depuis pending_admin uniquement", async () => {
    const denied = await request(app).patch(`/api/admin/commissions/${commission.id}/validate`).set(auth(analyst));
    expect(denied.status).toBe(403);

    const ok = await request(app).patch(`/api/admin/commissions/${commission.id}/validate`).set(auth(moderator));
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('validated');
    expect(ok.body.adminValidatedAt).not.toBeNull();

    const again = await request(app).patch(`/api/admin/commissions/${commission.id}/validate`).set(auth(moderator));
    expect(again.status).toBe(409);
  });

  test('le compteur public compte la ligne validee', async () => {
    const res = await request(app).get(`/api/listings/${listing.id}`);
    expect(res.body.realizedEventsCount).toBe(1);
    // Conditions commerciales jamais exposees publiquement.
    expect(res.body.category.commissionValue).toBeUndefined();
  });
});

describe('Tarif fige a la creation', () => {
  test('modifier commission_value de la categorie ne change pas les lignes existantes', async () => {
    const lead = await createLead(listing.id, 'frozen.client@example.com');
    const before = await confirm(lead);
    expect(before.status).toBe(201);

    const patch = await request(app)
      .patch(`/api/admin/categories/${venues.id}`)
      .set(auth(superAdmin))
      .send({ commissionEnabled: true, commissionValue: 450 });
    expect(patch.status).toBe(200);

    const existing = await Commission.findByPk(before.body.id);
    expect(Number(existing.amount)).toBe(300);
    expect(Number(existing.commissionValue)).toBe(300);

    const newLead = await createLead(listing.id, 'frozen.new@example.com');
    const after = await confirm(newLead);
    expect(Number(after.body.amount)).toBe(450);

    // Remise a 300 pour la suite des tests.
    await Category.update({ commissionValue: 300 }, { where: { id: venues.id } });
  });

  test('activer une categorie exige un montant fixe (400)', async () => {
    const res = await request(app)
      .patch(`/api/admin/categories/${venues.id}`)
      .set(auth(superAdmin))
      .send({ commissionEnabled: true, commissionValue: 0 });
    expect(res.status).toBe(400);
  });
});

describe('Controle d acces', () => {
  let otherCommission;

  beforeAll(async () => {
    const lead = await createLead(otherListing.id, 'access.client@example.com');
    const res = await confirm(lead, otherProvider);
    expect(res.status).toBe(201);
    otherCommission = await Commission.findByPk(res.body.id);
  });

  test("un prestataire ne voit pas les lignes d'un autre", async () => {
    const res = await request(app).get(`/api/listings/${otherListing.id}/commissions`).set(auth(provider));
    expect(res.status).toBe(403);

    const own = await request(app).get(`/api/listings/${listing.id}/commissions`).set(auth(provider));
    expect(own.status).toBe(200);
    expect(own.body.commissions.every((c) => c.listingId === listing.id)).toBe(true);
  });

  test("un prestataire ne peut ni confirmer la demande d'un autre, ni valider, ni contester ses lignes", async () => {
    const otherLead = await createLead(otherListing.id, 'access.other@example.com');
    expect((await confirm(otherLead, provider)).status).toBe(403);

    const validate = await request(app)
      .patch(`/api/admin/commissions/${otherCommission.id}/validate`)
      .set(auth(provider));
    expect(validate.status).toBe(403);

    const dispute = await request(app)
      .post(`/api/commissions/${otherCommission.id}/dispute`)
      .set(auth(provider))
      .send({ comment: 'Pas ma demande du tout' });
    expect(dispute.status).toBe(403);
    expect((await Commission.findByPk(otherCommission.id)).status).toBe('pending_admin');
  });
});

describe('Annulation, contestation, facturation, reglement', () => {
  test("l'annulation d'une ligne validee remet le compteur public a jour", async () => {
    const lead = await createLead(listing.id, 'cancel.client@example.com');
    const created = await confirm(lead);
    await request(app).patch(`/api/admin/commissions/${created.body.id}/validate`).set(auth(superAdmin));

    const before = await request(app).get(`/api/listings/${listing.id}`);

    const noReason = await request(app)
      .patch(`/api/admin/commissions/${created.body.id}/cancel`)
      .set(auth(superAdmin))
      .send({});
    expect(noReason.status).toBe(400);

    const res = await request(app)
      .patch(`/api/admin/commissions/${created.body.id}/cancel`)
      .set(auth(superAdmin))
      .send({ reason: 'Contrat annulé par le client' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    const after = await request(app).get(`/api/listings/${listing.id}`);
    expect(after.body.realizedEventsCount).toBe(before.body.realizedEventsCount - 1);
  });

  test('contestation : une ligne validee repasse pending_admin avec le commentaire', async () => {
    const lead = await createLead(listing.id, 'dispute.client@example.com');
    const created = await confirm(lead);
    const pending = await request(app)
      .post(`/api/commissions/${created.body.id}/dispute`)
      .set(auth(provider))
      .send({ comment: 'Encore en attente' });
    expect(pending.status).toBe(409);

    await request(app).patch(`/api/admin/commissions/${created.body.id}/validate`).set(auth(superAdmin));
    const res = await request(app)
      .post(`/api/commissions/${created.body.id}/dispute`)
      .set(auth(provider))
      .send({ comment: 'Le mariage a été annulé finalement' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_admin');
    expect(res.body.disputeComment).toBe('Le mariage a été annulé finalement');
  });

  test('facture mensuelle : lignes validees seulement, puis figees ; reglement -> paid', async () => {
    const validatedBefore = await Commission.findAll({ where: { listingId: listing.id, status: 'validated' } });
    const pendingBefore = await Commission.count({ where: { listingId: listing.id, status: 'pending_admin' } });
    expect(validatedBefore.length).toBeGreaterThan(0);

    const res = await request(app)
      .post('/api/admin/commissions/invoice')
      .set(auth(superAdmin))
      .send({ month: currentMonth(), listingId: listing.id });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    const invoice = res.body.created[0];
    const expectedTotal = validatedBefore.reduce((sum, c) => sum + Number(c.amount), 0);
    expect(Number(invoice.amount)).toBe(expectedTotal);
    expect(invoice.pdfUrl).toMatch(/^\/uploads\/documents\//);

    const invoiced = await Commission.findAll({ where: { invoiceId: invoice.id } });
    expect(invoiced).toHaveLength(validatedBefore.length);
    expect(invoiced.every((c) => c.status === 'invoiced')).toBe(true);
    expect(await Commission.count({ where: { listingId: listing.id, status: 'pending_admin' } })).toBe(pendingBefore);

    // Facturee : plus annulable ni contestable.
    const cancel = await request(app)
      .patch(`/api/admin/commissions/${invoiced[0].id}/cancel`)
      .set(auth(superAdmin))
      .send({ reason: 'Essai' });
    expect(cancel.status).toBe(409);
    const dispute = await request(app)
      .post(`/api/commissions/${invoiced[0].id}/dispute`)
      .set(auth(provider))
      .send({ comment: 'Trop tard pour contester' });
    expect(dispute.status).toBe(409);

    // Pas de double facturation : une nouvelle generation ne reprend rien.
    const again = await request(app)
      .post('/api/admin/commissions/invoice')
      .set(auth(superAdmin))
      .send({ month: currentMonth(), listingId: listing.id });
    expect(again.body.created).toHaveLength(0);

    const paid = await request(app)
      .patch(`/api/admin/commissions/invoices/${invoice.id}/status`)
      .set(auth(superAdmin))
      .send({ status: 'paid' });
    expect(paid.status).toBe(200);
    const paidLines = await Commission.findAll({ where: { invoiceId: invoice.id } });
    expect(paidLines.every((c) => c.status === 'paid')).toBe(true);

    const reopen = await request(app)
      .patch(`/api/admin/commissions/invoices/${invoice.id}/status`)
      .set(auth(superAdmin))
      .send({ status: 'cancelled' });
    expect(reopen.status).toBe(409);
  });

  test('facture annulee : les lignes redeviennent validees, refacturables', async () => {
    const lead = await createLead(listing.id, 'reinvoice.client@example.com');
    const created = await confirm(lead);
    await request(app).patch(`/api/admin/commissions/${created.body.id}/validate`).set(auth(superAdmin));
    const res = await request(app)
      .post('/api/admin/commissions/invoice')
      .set(auth(superAdmin))
      .send({ month: currentMonth(), listingId: listing.id });
    const invoiceId = res.body.created[0].id;

    await request(app)
      .patch(`/api/admin/commissions/invoices/${invoiceId}/status`)
      .set(auth(superAdmin))
      .send({ status: 'cancelled' });
    const line = await Commission.findByPk(created.body.id);
    expect(line.status).toBe('validated');
    expect(line.invoiceId).toBeNull();
    expect((await CommissionInvoice.findByPk(invoiceId)).status).toBe('cancelled');
  });

  test("seul le super admin genere les factures", async () => {
    const res = await request(app)
      .post('/api/admin/commissions/invoice')
      .set(auth(moderator))
      .send({ month: currentMonth() });
    expect(res.status).toBe(403);
  });

  test('fiche sans acceptation des conditions : ignoree a la facturation', async () => {
    // Acceptation retiree a posteriori (ex. nouvelle version non acceptee).
    const lead = await createLead(otherListing.id, 'noterms.client@example.com');
    const created = await confirm(lead, otherProvider);
    await request(app).patch(`/api/admin/commissions/${created.body.id}/validate`).set(auth(superAdmin));
    await otherListing.update({ connectionFeeTermsAcceptedAt: null, connectionFeeTermsVersion: null });

    const res = await request(app)
      .post('/api/admin/commissions/invoice')
      .set(auth(superAdmin))
      .send({ month: currentMonth(), listingId: otherListing.id });
    expect(res.body.created).toHaveLength(0);
    expect(res.body.skipped[0].listingId).toBe(otherListing.id);
    expect((await Commission.findByPk(created.body.id)).status).toBe('validated');
  });
});

describe('Incitations', () => {
  test("evenement passe + validation : reservation terminee et invitation a l'avis envoyee une fois", async () => {
    const lead = await createLead(listing.id, 'past.client@example.com', { eventDate: dateFromToday(-3) });
    const created = await confirm(lead, provider, { eventDate: dateFromToday(-3) });
    expect(created.status).toBe(201);

    await request(app).patch(`/api/admin/commissions/${created.body.id}/validate`).set(auth(superAdmin));
    const commission = await Commission.findByPk(created.body.id);
    expect(commission.reviewInviteSentAt).not.toBeNull();
    expect((await Booking.findOne({ where: { leadId: lead.id } })).status).toBe('completed');

    // Le cron ne renvoie pas une seconde invitation.
    const before = commission.reviewInviteSentAt.getTime();
    await sendDueReviewInvites();
    expect((await Commission.findByPk(created.body.id)).reviewInviteSentAt.getTime()).toBe(before);
  });

  test('evenement a venir : invitation differee (cron)', async () => {
    const lead = await createLead(listing.id, 'future.client@example.com');
    const created = await confirm(lead);
    await request(app).patch(`/api/admin/commissions/${created.body.id}/validate`).set(auth(superAdmin));
    expect((await Commission.findByPk(created.body.id)).reviewInviteSentAt).toBeNull();
  });

  test('taux de conversion : seules les demandes validees comptent dans une categorie concernee', async () => {
    const res = await request(app).get(`/api/listings/${listing.id}/leads`).set(auth(provider));
    expect(res.status).toBe(200);
    const validatedLeads = res.body.leads.filter((lead) =>
      ['validated', 'invoiced', 'paid'].includes(lead.commission?.status)
    ).length;
    expect(res.body.stats.convertedCount).toBe(validatedLeads);
    expect(res.body.stats.conversionRate).toBe(Math.round((validatedLeads / res.body.leads.length) * 100));
    expect(res.body.connectionFee).toMatchObject({ concerned: true, amount: 300, termsAccepted: true });
  });

  test('classement : a note egale, la fiche avec des evenements realises passe devant', async () => {
    const res = await request(app).get('/api/listings').query({ category: 'salles-de-fetes' });
    expect(res.status).toBe(200);
    const ids = res.body.results.map((r) => r.id);
    expect(ids.indexOf(listing.id)).toBeLessThan(ids.indexOf(otherListing.id));
  });

  test('statistiques admin : totaux par mois, categorie et taux de confirmation', async () => {
    const res = await request(app).get('/api/admin/commissions/stats').set(auth(analyst));
    expect(res.status).toBe(200);
    expect(res.body.byMonth).toHaveLength(12);
    expect(res.body.byCategory[0].name).toBe('Lieux de mariage');
    const row = res.body.providers.find((p) => p.listingId === listing.id);
    expect(row.confirmedCount).toBeGreaterThan(0);
  });

  test("file d'attente admin : filtre par statut avec le detail du lead", async () => {
    const res = await request(app)
      .get('/api/admin/commissions')
      .query({ status: 'pending_admin' })
      .set(auth(analyst));
    expect(res.status).toBe(200);
    expect(res.body.commissions.every((c) => c.status === 'pending_admin')).toBe(true);
    expect(res.body.commissions[0].lead.email).toBeDefined();
    expect(res.body.commissions[0].listing.owner.email).toBeDefined();
  });
});

describe('Onboarding admin', () => {
  test("creation d'un prestataire en categorie concernee : acceptation obligatoire", async () => {
    const halls = await Category.findOne({ where: { slug: 'salles-de-fetes' } });
    const base = {
      firstName: 'Nour',
      lastName: 'Salle',
      phone: '+21629000111',
      title: 'Salle Nour',
      categoryId: String(halls.id),
    };
    const refused = await request(app)
      .post('/api/admin/providers')
      .set(auth(superAdmin))
      .field({ ...base, email: 'nour.refused@example.com' });
    expect(refused.status).toBe(400);

    const ok = await request(app)
      .post('/api/admin/providers')
      .set(auth(superAdmin))
      .field({ ...base, email: 'nour.ok@example.com', phone: '+21629000112', connectionFeeTermsAccepted: 'true' });
    expect(ok.status).toBe(201);
    const created = await Listing.findOne({ where: { title: 'Salle Nour' } });
    expect(created.connectionFeeTermsVersion).toBe('2026-10-v1');
    expect(created.connectionFeeTermsAcceptedAt).not.toBeNull();
  });
});

describe('Frais en pourcentage du contrat', () => {
  let traiteur;
  let percentListing;
  let percentProvider;

  beforeAll(async () => {
    traiteur = await Category.create({ name: 'Traiteurs', slug: 'traiteurs' });
    const sub = await Category.create({ name: 'Traiteur', slug: 'traiteur', parentId: traiteur.id });
    percentProvider = await makeUser('provider', 'fees.percent@example.com');
    percentListing = await Listing.create({
      userId: percentProvider.id,
      categoryId: sub.id,
      title: 'Traiteur Pourcentage',
      city: 'Tunis',
      status: 'active',
      connectionFeeTermsAcceptedAt: new Date(),
      connectionFeeTermsVersion: '2026-10-v1',
    });
  });

  test("l'admin active un pourcentage (taux <= 100 %)", async () => {
    const tooHigh = await request(app)
      .patch(`/api/admin/categories/${traiteur.id}`)
      .set(auth(superAdmin))
      .send({ commissionEnabled: true, commissionType: 'percent', commissionValue: 120 });
    expect(tooHigh.status).toBe(400);

    const res = await request(app)
      .patch(`/api/admin/categories/${traiteur.id}`)
      .set(auth(superAdmin))
      .send({ commissionEnabled: true, commissionType: 'percent', commissionValue: 5 });
    expect(res.status).toBe(200);
    expect(res.body.commissionType).toBe('percent');
  });

  test('montant du contrat obligatoire en pourcentage (400)', async () => {
    const lead = await createLead(percentListing.id, 'percent.missing@example.com');
    const res = await confirm(lead, percentProvider);
    expect(res.status).toBe(400);
    expect(await Commission.count({ where: { leadId: lead.id } })).toBe(0);
  });

  test('frais = taux x montant declare, calcules cote serveur et figes', async () => {
    const lead = await createLead(percentListing.id, 'percent.ok@example.com');
    const res = await confirm(lead, percentProvider, { declaredAmount: 8000, amount: 1 });
    expect(res.status).toBe(201);
    expect(res.body.commissionType).toBe('percent');
    expect(Number(res.body.amount)).toBe(400);

    await request(app)
      .patch(`/api/admin/categories/${traiteur.id}`)
      .set(auth(superAdmin))
      .send({ commissionValue: 10 });
    const line = await Commission.findByPk(res.body.id);
    expect(Number(line.commissionValue)).toBe(5);
    expect(Number(line.amount)).toBe(400);

    const leads = await request(app).get(`/api/listings/${percentListing.id}/leads`).set(auth(percentProvider));
    expect(leads.body.connectionFee).toMatchObject({ concerned: true, type: 'percent', value: 10, amount: null });
  });
});

describe('Factures visibles par le prestataire', () => {
  test('le prestataire voit ses factures de frais, jamais celles des autres', async () => {
    const own = await request(app).get(`/api/listings/${listing.id}/commissions`).set(auth(provider));
    expect(own.status).toBe(200);
    expect(own.body.invoices.length).toBeGreaterThan(0);
    expect(own.body.invoices.every((invoice) => invoice.listingId === undefined || invoice.listingId === listing.id)).toBe(true);
    const ownIds = new Set(own.body.invoices.map((i) => i.id));
    const others = await CommissionInvoice.findAll({ where: { listingId: otherListing.id } });
    expect(others.every((i) => !ownIds.has(i.id))).toBe(true);
    expect(own.body.terms.accepted).toBe(true);
  });
});

describe('Declaration automatique a la confirmation de la demande', () => {
  let autoProvider;
  let autoListing;

  beforeAll(async () => {
    const parent = await Category.create({
      name: 'Réceptions auto',
      slug: 'receptions-auto',
      commissionEnabled: true,
      commissionType: 'percent',
      commissionValue: 5,
    });
    const sub = await Category.create({ name: 'Salle auto', slug: 'salle-auto', parentId: parent.id });
    autoProvider = await makeUser('provider', 'fees.auto@example.com');
    autoListing = await Listing.create({
      userId: autoProvider.id,
      categoryId: sub.id,
      title: 'Salle Auto',
      city: 'Tunis',
      status: 'active',
      connectionFeeTermsAcceptedAt: new Date(),
      connectionFeeTermsVersion: '2026-10-v1',
    });
  });

  const bookFromLead = (lead, body = {}) =>
    request(app)
      .post('/api/bookings')
      .set(auth(autoProvider))
      .send({ leadId: lead.id, eventDate: dateFromToday(50), ...body });

  test('reservation avec montant : frais en pourcentage declares automatiquement (pending_admin)', async () => {
    const lead = await createLead(autoListing.id, 'auto.percent@example.com');
    const res = await bookFromLead(lead, { totalPrice: 10000 });
    expect(res.status).toBe(201);
    const fee = await Commission.findOne({ where: { leadId: lead.id } });
    expect(fee.status).toBe('pending_admin');
    expect(fee.commissionType).toBe('percent');
    expect(Number(fee.declaredAmount)).toBe(10000);
    expect(Number(fee.amount)).toBe(500);
    expect(fee.providerConfirmedAt).not.toBeNull();
  });

  test('montant modifie avant validation : frais recalcules ; apres validation : figes', async () => {
    const lead = await createLead(autoListing.id, 'auto.sync@example.com');
    const created = await bookFromLead(lead, { totalPrice: 4000 });
    const fee = await Commission.findOne({ where: { leadId: lead.id } });
    expect(Number(fee.amount)).toBe(200);

    await request(app).patch(`/api/bookings/${created.body.id}`).set(auth(autoProvider)).send({ totalPrice: 6000 });
    await fee.reload();
    expect(Number(fee.amount)).toBe(300);
    expect(Number(fee.declaredAmount)).toBe(6000);

    await request(app).patch(`/api/admin/commissions/${fee.id}/validate`).set(auth(superAdmin));
    await request(app).patch(`/api/bookings/${created.body.id}`).set(auth(autoProvider)).send({ totalPrice: 9000 });
    await fee.reload();
    expect(Number(fee.amount)).toBe(300);
  });

  test('pourcentage sans montant : rien de declare, confirmation manuelle requise', async () => {
    const lead = await createLead(autoListing.id, 'auto.noprice@example.com');
    const res = await bookFromLead(lead);
    expect(res.status).toBe(201);
    expect(await Commission.count({ where: { leadId: lead.id } })).toBe(0);
  });

  test('forfait fixe : passage au statut converti -> frais declares automatiquement', async () => {
    const lead = await createLead(listing.id, 'auto.fixed@example.com');
    const res = await request(app)
      .patch(`/api/leads/${lead.id}/status`)
      .set(auth(provider))
      .send({ status: 'converted' });
    expect(res.status).toBe(200);
    const fee = await Commission.findOne({ where: { leadId: lead.id } });
    expect(fee.status).toBe('pending_admin');
    expect(Number(fee.amount)).toBe(300);
  });

  test('conditions non acceptees : aucune declaration automatique', async () => {
    await autoListing.update({ connectionFeeTermsAcceptedAt: null, connectionFeeTermsVersion: null });
    const lead = await createLead(autoListing.id, 'auto.noterms@example.com');
    await bookFromLead(lead, { totalPrice: 5000 });
    expect(await Commission.count({ where: { leadId: lead.id } })).toBe(0);
  });
});

describe('Base du pourcentage : montant total, jamais l acompte', () => {
  test('confirmation manuelle : le total de la reservation existante prime sur la saisie', async () => {
    const parent = await Category.create({
      name: 'Base totale',
      slug: 'base-totale',
      commissionEnabled: true,
      commissionType: 'percent',
      commissionValue: 5,
    });
    const owner = await makeUser('provider', 'fees.base@example.com');
    const baseListing = await Listing.create({
      userId: owner.id,
      categoryId: parent.id,
      title: 'Salle Base',
      city: 'Tunis',
      status: 'active',
    });
    const lead = await createLead(baseListing.id, 'base.total@example.com');
    // Reservation enregistree avant l'acceptation des conditions : pas de frais auto.
    await request(app)
      .post('/api/bookings')
      .set(auth(owner))
      .send({ leadId: lead.id, eventDate: dateFromToday(60), totalPrice: 3000, deposit: 1000 });
    expect(await Commission.count({ where: { leadId: lead.id } })).toBe(0);

    await baseListing.update({ connectionFeeTermsAcceptedAt: new Date(), connectionFeeTermsVersion: '2026-10-v1' });
    const res = await confirm(lead, owner, { declaredAmount: 1000 });
    expect(res.status).toBe(201);
    expect(Number(res.body.declaredAmount)).toBe(3000);
    expect(Number(res.body.amount)).toBe(150);
  });
});
