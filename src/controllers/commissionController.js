const { Op, fn, col } = require('sequelize');
const { validationResult } = require('express-validator');
const db = require('../models');
const crmService = require('../services/crmService');
const pdfService = require('../services/pdfService');
const feeService = require('../services/connectionFeeService');
const { sendReviewInviteIfDue } = require('../services/commissionCronService');

const { Commission, CommissionInvoice, Lead, Listing, Category, Booking, User } = db;

// Frais de mise en relation (MODULES.md M13) : forfait fixe ou pourcentage
// du contrat declare, par demande aboutie dans une categorie concernee, apres
// DOUBLE confirmation
// (prestataire puis admin). Aucun paiement en ligne : facture mensuelle
// reglee hors plateforme. Tous les montants sont calcules ici, jamais lus
// depuis le client.

const LEAD_ATTRIBUTES = [
  'id',
  'firstName',
  'lastName',
  'email',
  'phone',
  'eventDate',
  'checkInDate',
  'checkOutDate',
  'guests',
  'message',
  'status',
  'createdAt',
];

function sendValidationErrors(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ errors: errors.array() });
  return true;
}

const startOfMonth = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), 1);
const startOfYear = (date = new Date()) => new Date(date.getFullYear(), 0, 1);

async function sumAmount(where) {
  const total = await Commission.sum('amount', { where });
  return feeService.round2(total || 0);
}

// La demande aboutie laisse une trace de reservation (M5) si le prestataire
// n'en a pas deja enregistre une : meme logique que le passage "converti".
async function ensureBookingForLead(lead, listing, eventDate, declaredAmount) {
  const existing = await Booking.findOne({ where: { leadId: lead.id } });
  if (existing) return existing;
  const client = await crmService.findOrCreateClientForLead(lead, listing);
  await crmService.registerConvertedEvent(client);
  const booking = await Booking.create({
    leadId: lead.id,
    listingId: listing.id,
    clientId: client.id,
    userId: lead.userId,
    eventDate: eventDate || lead.eventDate || lead.checkInDate || null,
    checkInDate: lead.checkInDate || null,
    checkOutDate: lead.checkOutDate || null,
    rooms: lead.rooms || null,
    guests: lead.guests || null,
    packageId: lead.packageId || null,
    totalPrice: declaredAmount || null,
    status: 'confirmed',
  });
  await crmService.recalculateClientFinancials(client);
  return booking;
}

// --- Prestataire ---------------------------------------------------------

// POST /api/leads/:id/confirm : le prestataire declare la demande aboutie
// (1re confirmation) -> ligne 'pending_admin', en attente de l'admin.
exports.confirmLead = async (req, res, next) => {
  if (sendValidationErrors(req, res)) return;
  try {
    const lead = await Lead.findByPk(req.params.id, { include: [{ model: Listing, as: 'listing' }] });
    if (!lead || !lead.listing) {
      return res.status(404).json({ message: 'Demande introuvable.' });
    }
    const { listing } = lead;
    if (listing.userId !== req.user.id) {
      return res.status(403).json({ message: 'Accès interdit.' });
    }
    if (lead.providerEventId) {
      return res.status(400).json({ message: "Une demande d'intérêt sur un événement n'est pas concernée." });
    }
    if (lead.status === 'lost') {
      return res.status(409).json({ message: 'Cette demande est marquée comme perdue.' });
    }

    const category = await feeService.resolveFeeCategory(listing);
    if (!category) {
      return res.status(400).json({ message: "Votre catégorie n'est pas concernée par les frais de mise en relation." });
    }
    if (!feeService.hasAcceptedTerms(listing)) {
      return res.status(403).json({
        message: 'Acceptez les conditions des frais de mise en relation avant de confirmer une demande.',
        termsRequired: true,
      });
    }
    if (await Commission.findOne({ where: { leadId: lead.id } })) {
      return res.status(409).json({ message: 'Cette demande a déjà été confirmée.' });
    }

    const { eventDate } = req.body;
    // Base de calcul : le MONTANT TOTAL de la reservation deja enregistree pour
    // cette demande (jamais l'acompte) - la saisie du formulaire ne sert que
    // s'il n'existe pas encore de reservation chiffree.
    const existingBooking = await Booking.findOne({ where: { leadId: lead.id }, attributes: ['totalPrice'] });
    const declaredAmount =
      Number(existingBooking?.totalPrice) > 0 ? Number(existingBooking.totalPrice) : req.body.declaredAmount;
    const amount = feeService.computeFeeAmount(category, declaredAmount);
    if (amount === null) {
      return res.status(400).json({
        message: 'Le montant du contrat est obligatoire : les frais sont calculés en pourcentage de ce montant.',
      });
    }
    let commission;
    try {
      commission = await Commission.create({
        leadId: lead.id,
        listingId: listing.id,
        categoryId: category.id,
        eventDate,
        declaredAmount: declaredAmount || null,
        // Tarif FIGE a la creation : une modification ulterieure de la
        // categorie ne change jamais cette ligne.
        commissionType: category.commissionType || 'fixed',
        commissionValue: category.commissionValue,
        amount,
        status: 'pending_admin',
        providerConfirmedAt: new Date(),
      });
    } catch (err) {
      // Course entre deux confirmations simultanees : la contrainte UNIQUE
      // sur lead_id garantit qu'une seule ligne existe.
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ message: 'Cette demande a déjà été confirmée.' });
      }
      throw err;
    }

    if (lead.status !== 'converted') {
      if (!lead.answeredAt) lead.answeredAt = new Date();
      lead.status = 'converted';
      await lead.save();
    }
    await ensureBookingForLead(lead, listing, eventDate, declaredAmount);

    return res.status(201).json(commission);
  } catch (err) {
    return next(err);
  }
};

// GET /api/listings/:id/commissions : lignes de SA fiche uniquement.
exports.getListingCommissions = async (req, res, next) => {
  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Prestataire introuvable.' });
    }
    if (listing.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    const [category, commissions, monthTotal, yearTotal, realizedCount, invoices] = await Promise.all([
      feeService.resolveFeeCategory(listing),
      Commission.findAll({
        where: { listingId: listing.id },
        include: [
          { model: Lead, as: 'lead', attributes: ['id', 'firstName', 'lastName', 'eventDate', 'checkInDate'] },
          { model: Category, as: 'category', attributes: ['id', 'name'] },
          { model: CommissionInvoice, as: 'invoice', attributes: ['id', 'number', 'status', 'pdfUrl'] },
        ],
        order: [['providerConfirmedAt', 'DESC']],
      }),
      sumAmount({
        listingId: listing.id,
        status: feeService.ACTIVE_STATUSES,
        providerConfirmedAt: { [Op.gte]: startOfMonth() },
      }),
      sumAmount({
        listingId: listing.id,
        status: feeService.ACTIVE_STATUSES,
        providerConfirmedAt: { [Op.gte]: startOfYear() },
      }),
      feeService.countRealizedEvents(listing.id),
      // Factures mensuelles Mounesba de CETTE fiche uniquement.
      CommissionInvoice.findAll({
        where: { listingId: listing.id },
        attributes: ['id', 'number', 'period', 'amount', 'status', 'issuedAt', 'dueDate', 'paidAt', 'pdfUrl'],
        order: [['issuedAt', 'DESC'], ['id', 'DESC']],
      }),
    ]);

    return res.json({
      concerned: Boolean(category) || commissions.length > 0,
      fee: category ? feeService.describeRate(category) : null,
      terms: {
        accepted: feeService.hasAcceptedTerms(listing),
        acceptedAt: listing.connectionFeeTermsAcceptedAt,
        version: listing.connectionFeeTermsVersion,
        currentVersion: feeService.TERMS_VERSION,
      },
      realizedCount,
      totals: { month: monthTotal, year: yearTotal },
      commissions,
      invoices,
    });
  } catch (err) {
    return next(err);
  }
};

// POST /api/listings/me/connection-fee-terms : acceptation par le
// prestataire lui-meme (date + version enregistrees).
exports.acceptTerms = async (req, res, next) => {
  if (sendValidationErrors(req, res)) return;
  try {
    const listing = await Listing.findOne({ where: { userId: req.user.id } });
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }
    if (listing.connectionFeeTermsVersion !== feeService.TERMS_VERSION) {
      listing.connectionFeeTermsAcceptedAt = new Date();
      listing.connectionFeeTermsVersion = feeService.TERMS_VERSION;
      await listing.save();
    }
    return res.json({
      accepted: true,
      acceptedAt: listing.connectionFeeTermsAcceptedAt,
      version: listing.connectionFeeTermsVersion,
    });
  } catch (err) {
    return next(err);
  }
};

// POST /api/commissions/:id/dispute : contestation d'une ligne validee non
// facturee -> repasse 'pending_admin' avec le commentaire du prestataire.
exports.disputeCommission = async (req, res, next) => {
  if (sendValidationErrors(req, res)) return;
  try {
    const commission = await Commission.findByPk(req.params.id, {
      include: [{ model: Listing, as: 'listing', attributes: ['id', 'userId'] }],
    });
    if (!commission) {
      return res.status(404).json({ message: 'Ligne introuvable.' });
    }
    if (commission.listing?.userId !== req.user.id) {
      return res.status(403).json({ message: 'Accès interdit.' });
    }
    if (commission.status !== 'validated') {
      return res.status(409).json({
        message: 'Seuls les frais validés et non encore facturés peuvent être contestés.',
      });
    }
    commission.status = 'pending_admin';
    commission.disputeComment = req.body.comment.trim();
    commission.disputedAt = new Date();
    commission.adminValidatedAt = null;
    await commission.save();
    return res.json(commission);
  } catch (err) {
    return next(err);
  }
};

// --- Admin -------------------------------------------------------------

function buildAdminWhere(query) {
  const { status, listingId, categoryId, from, to } = query;
  const where = {};
  if (status && Commission.STATUSES.includes(status)) where.status = status;
  if (listingId) where.listingId = Number(listingId);
  if (categoryId) where.categoryId = Number(categoryId);
  if (from || to) {
    where.providerConfirmedAt = {};
    if (from) where.providerConfirmedAt[Op.gte] = new Date(`${from}T00:00:00`);
    if (to) where.providerConfirmedAt[Op.lte] = new Date(`${to}T23:59:59`);
  }
  return where;
}

// GET /api/admin/commissions : file d'attente + filtres, avec le detail du
// lead d'origine (coordonnees du client pour verification).
exports.getAdminCommissions = async (req, res, next) => {
  try {
    const pageNum = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const where = buildAdminWhere(req.query);

    const [{ rows, count }, statusRows] = await Promise.all([
      Commission.findAndCountAll({
        where,
        include: [
          { model: Lead, as: 'lead', attributes: LEAD_ATTRIBUTES },
          {
            model: Listing,
            as: 'listing',
            attributes: ['id', 'title', 'connectionFeeTermsAcceptedAt', 'connectionFeeTermsVersion'],
            paranoid: false,
            include: [{ model: User, as: 'owner', attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] }],
          },
          { model: Category, as: 'category', attributes: ['id', 'name'] },
          { model: CommissionInvoice, as: 'invoice', attributes: ['id', 'number', 'status', 'pdfUrl'] },
          { model: User, as: 'validatedBy', attributes: ['id', 'firstName', 'lastName'] },
        ],
        order: [['providerConfirmedAt', 'DESC']],
        limit: limitNum,
        offset: (pageNum - 1) * limitNum,
        distinct: true,
      }),
      Commission.findAll({
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),
    ]);

    return res.json({
      commissions: rows,
      statusCounts: Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)])),
      pagination: { page: pageNum, limit: limitNum, total: count, totalPages: Math.ceil(count / limitNum) || 1 },
    });
  } catch (err) {
    return next(err);
  }
};

// PATCH /api/admin/commissions/:id/validate : 2e confirmation (admin),
// uniquement depuis 'pending_admin'.
exports.validateCommission = async (req, res, next) => {
  try {
    const commission = await Commission.findByPk(req.params.id);
    if (!commission) {
      return res.status(404).json({ message: 'Ligne introuvable.' });
    }
    if (commission.status !== 'pending_admin') {
      return res.status(409).json({ message: 'Seule une ligne en attente de validation peut être validée.' });
    }
    commission.status = 'validated';
    commission.adminValidatedAt = new Date();
    commission.adminUserId = req.user.id;
    await commission.save();

    // Incitation (M13) : invitation du client a laisser un avis verifie si
    // l'evenement est deja passe (sinon envoyee par le cron le moment venu).
    // Non bloquant : un echec d'email n'annule jamais la validation.
    await sendReviewInviteIfDue(commission).catch((err) =>
      console.error('Invitation avis non envoyee :', err.message)
    );

    return res.json(commission);
  } catch (err) {
    return next(err);
  }
};

// PATCH /api/admin/commissions/:id/cancel : motif obligatoire. Jamais une
// ligne facturee ou payee.
exports.cancelCommission = async (req, res, next) => {
  if (sendValidationErrors(req, res)) return;
  try {
    const commission = await Commission.findByPk(req.params.id);
    if (!commission) {
      return res.status(404).json({ message: 'Ligne introuvable.' });
    }
    if (!feeService.OPEN_STATUSES.includes(commission.status)) {
      return res.status(409).json({
        message:
          commission.status === 'cancelled'
            ? 'Cette ligne est déjà annulée.'
            : "Une ligne facturée ou payée n'est plus modifiable ni annulable.",
      });
    }
    commission.status = 'cancelled';
    commission.cancelReason = req.body.reason.trim();
    commission.adminUserId = req.user.id;
    await commission.save();
    return res.json(commission);
  } catch (err) {
    return next(err);
  }
};

async function generateInvoiceNumber(transaction) {
  const year = new Date().getFullYear();
  const count = await CommissionInvoice.count({
    where: { number: { [Op.like]: `FMR-${year}-%` } },
    transaction,
  });
  return `FMR-${year}-${String(count + 1).padStart(4, '0')}`;
}

// POST /api/admin/commissions/invoice : une facture par prestataire pour le
// mois donne, regroupant ses lignes 'validated' (validees avant la fin du
// mois). Une ligne 'pending_admin' n'est jamais facturable. Fiche sans
// acceptation des conditions : ignoree (aucun frais reclamable).
exports.generateMonthlyInvoices = async (req, res, next) => {
  if (sendValidationErrors(req, res)) return;
  try {
    const { month, listingId } = req.body;
    const { end } = feeService.monthRange(month);
    const where = { status: 'validated', adminValidatedAt: { [Op.lt]: end } };
    if (listingId) where.listingId = listingId;

    const lines = await Commission.findAll({
      where,
      include: [{ model: Lead, as: 'lead', attributes: ['id', 'firstName', 'lastName'] }],
      order: [['eventDate', 'ASC']],
    });
    const byListing = new Map();
    lines.forEach((line) => {
      const key = Number(line.listingId);
      if (!byListing.has(key)) byListing.set(key, []);
      byListing.get(key).push(line);
    });

    const created = [];
    const skipped = [];
    for (const [id, listingLines] of byListing) {
      const listing = await Listing.findByPk(id, {
        paranoid: false,
        include: [{ model: User, as: 'owner', attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] }],
      });
      if (!feeService.hasAcceptedTerms(listing)) {
        skipped.push({ listingId: id, title: listing?.title, reason: 'Conditions non acceptées par le prestataire.' });
        continue;
      }

      const amount = feeService.round2(listingLines.reduce((sum, line) => sum + Number(line.amount), 0));
      const issuedAt = new Date();
      const dueDate = new Date(issuedAt);
      dueDate.setDate(dueDate.getDate() + 15);

      const invoice = await db.sequelize.transaction(async (transaction) => {
        const newInvoice = await CommissionInvoice.create(
          {
            listingId: id,
            number: await generateInvoiceNumber(transaction),
            period: month,
            amount,
            status: 'unpaid',
            issuedAt: issuedAt.toISOString().slice(0, 10),
            dueDate: dueDate.toISOString().slice(0, 10),
          },
          { transaction }
        );
        // Seules les lignes encore 'validated' passent 'invoiced' (garde-fou
        // si une ligne a ete contestee/annulee entre-temps).
        const [updated] = await Commission.update(
          { status: 'invoiced', invoiceId: newInvoice.id },
          { where: { id: listingLines.map((line) => line.id), status: 'validated' }, transaction }
        );
        if (updated !== listingLines.length) {
          throw Object.assign(new Error('Lignes modifiées pendant la facturation, réessayez.'), { status: 409 });
        }
        return newInvoice;
      });

      invoice.pdfUrl = await pdfService.generateCommissionInvoicePdf(invoice, listing, listing.owner, listingLines);
      await invoice.save();
      created.push({ ...invoice.toJSON(), listing: { id: listing.id, title: listing.title }, linesCount: listingLines.length });
    }

    return res.status(created.length > 0 ? 201 : 200).json({ created, skipped });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ message: err.message });
    return next(err);
  }
};

// GET /api/admin/commissions/invoices
exports.getCommissionInvoices = async (req, res, next) => {
  try {
    const where = {};
    if (['unpaid', 'paid', 'cancelled'].includes(req.query.status)) where.status = req.query.status;
    if (req.query.period) where.period = req.query.period;
    const invoices = await CommissionInvoice.findAll({
      where,
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'title'],
          paranoid: false,
          include: [{ model: User, as: 'owner', attributes: ['id', 'firstName', 'lastName', 'email'] }],
        },
      ],
      order: [['createdAt', 'DESC']],
    });
    return res.json(invoices);
  } catch (err) {
    return next(err);
  }
};

// PATCH /api/admin/commissions/invoices/:id/status : 'paid' (reglement recu
// hors plateforme -> lignes 'paid') ou 'cancelled' (facture erronee : les
// lignes redeviennent 'validated', refacturables). Une facture payee est figee.
exports.updateCommissionInvoiceStatus = async (req, res, next) => {
  if (sendValidationErrors(req, res)) return;
  try {
    const invoice = await CommissionInvoice.findByPk(req.params.id);
    if (!invoice) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (invoice.status !== 'unpaid') {
      return res.status(409).json({ message: 'Seule une facture non payée peut changer de statut.' });
    }
    const { status } = req.body;
    await db.sequelize.transaction(async (transaction) => {
      invoice.status = status;
      if (status === 'paid') invoice.paidAt = new Date();
      await invoice.save({ transaction });
      await Commission.update(
        status === 'paid' ? { status: 'paid' } : { status: 'validated', invoiceId: null },
        { where: { invoiceId: invoice.id, status: 'invoiced' }, transaction }
      );
    });
    return res.json(invoice);
  } catch (err) {
    return next(err);
  }
};

// GET /api/admin/commissions/stats : totaux par mois et par categorie (lignes
// realisees : validated/invoiced/paid) et taux de confirmation par
// prestataire (demandes confirmees / demandes passees "converties").
exports.getCommissionStats = async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);
    const realizedInYear = {
      status: feeService.REALIZED_STATUSES,
      adminValidatedAt: { [Op.gte]: yearStart, [Op.lt]: yearEnd },
    };

    const enabledCategories = await Category.findAll({ where: { commissionEnabled: true }, attributes: ['id'] });
    const enabledIds = enabledCategories.map((c) => c.id);
    const childCategories = enabledIds.length
      ? await Category.findAll({ where: { parentId: enabledIds }, attributes: ['id'] })
      : [];
    const concernedCategoryIds = [...enabledIds, ...childCategories.map((c) => c.id)];

    const [byMonthRows, byCategoryRows, monthTotal, pendingCount, concernedListings] = await Promise.all([
      Commission.findAll({
        where: realizedInYear,
        attributes: [
          [fn('MONTH', col('admin_validated_at')), 'month'],
          [fn('SUM', col('amount')), 'total'],
          [fn('COUNT', col('id')), 'count'],
        ],
        group: [fn('MONTH', col('admin_validated_at'))],
        raw: true,
      }),
      Commission.findAll({
        where: realizedInYear,
        attributes: ['categoryId', [fn('SUM', col('amount')), 'total'], [fn('COUNT', col('id')), 'count']],
        group: ['categoryId'],
        raw: true,
      }),
      sumAmount({ status: feeService.REALIZED_STATUSES, adminValidatedAt: { [Op.gte]: startOfMonth() } }),
      Commission.count({ where: { status: 'pending_admin' } }),
      concernedCategoryIds.length
        ? Listing.findAll({ where: { categoryId: concernedCategoryIds }, attributes: ['id', 'title'] })
        : [],
    ]);

    const categories = await Category.findAll({
      where: { id: byCategoryRows.map((row) => row.categoryId) },
      attributes: ['id', 'name'],
    });
    const categoryNames = new Map(categories.map((c) => [Number(c.id), c.name]));

    const listingIds = concernedListings.map((l) => l.id);
    const [convertedRows, confirmedRows, realizedCounts] = await Promise.all([
      listingIds.length
        ? Lead.findAll({
            where: { listingId: listingIds, status: 'converted', providerEventId: null },
            attributes: ['listingId', [fn('COUNT', col('id')), 'count']],
            group: ['listingId'],
            raw: true,
          })
        : [],
      listingIds.length
        ? Commission.findAll({
            where: { listingId: listingIds, status: { [Op.ne]: 'cancelled' } },
            attributes: ['listingId', [fn('COUNT', col('id')), 'count']],
            group: ['listingId'],
            raw: true,
          })
        : [],
      feeService.countRealizedByListing(listingIds),
    ]);
    const converted = new Map(convertedRows.map((r) => [Number(r.listingId), Number(r.count)]));
    const confirmed = new Map(confirmedRows.map((r) => [Number(r.listingId), Number(r.count)]));

    const providers = concernedListings
      .map((listing) => {
        const convertedCount = converted.get(Number(listing.id)) || 0;
        const confirmedCount = confirmed.get(Number(listing.id)) || 0;
        return {
          listingId: listing.id,
          title: listing.title,
          convertedCount,
          confirmedCount,
          realizedCount: realizedCounts.get(Number(listing.id)) || 0,
          confirmationRate: convertedCount > 0 ? Math.min(1, confirmedCount / convertedCount) : null,
        };
      })
      .filter((row) => row.convertedCount > 0 || row.confirmedCount > 0)
      .sort((a, b) => (a.confirmationRate ?? 2) - (b.confirmationRate ?? 2));

    const totalConverted = providers.reduce((sum, p) => sum + p.convertedCount, 0);
    const totalConfirmed = providers.reduce((sum, p) => sum + p.confirmedCount, 0);

    return res.json({
      year,
      monthTotal,
      pendingCount,
      byMonth: Array.from({ length: 12 }, (_, index) => {
        const row = byMonthRows.find((r) => Number(r.month) === index + 1);
        return { month: index + 1, total: feeService.round2(row?.total || 0), count: Number(row?.count || 0) };
      }),
      byCategory: byCategoryRows.map((row) => ({
        categoryId: Number(row.categoryId),
        name: categoryNames.get(Number(row.categoryId)) || '—',
        total: feeService.round2(row.total),
        count: Number(row.count),
      })),
      confirmationRate: totalConverted > 0 ? Math.min(1, totalConfirmed / totalConverted) : null,
      providers,
    });
  } catch (err) {
    return next(err);
  }
};
