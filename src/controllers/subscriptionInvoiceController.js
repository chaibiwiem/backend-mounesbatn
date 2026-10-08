const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const db = require('../models');
const pdfService = require('../services/pdfService');
const emailService = require('../services/emailService');
const { PLAN_CATALOG } = require('../services/planService');

const { SubscriptionInvoice, Subscription, Listing, User } = db;

async function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  const count = await SubscriptionInvoice.count({
    where: { number: { [Op.like]: `FACTURE-${year}-%` } },
  });
  return `FACTURE-${year}-${String(count + 1).padStart(4, '0')}`;
}

// Table complete des factures d'abonnement (onglet admin "Facturation > Factures").
exports.getSubscriptionInvoices = async (req, res, next) => {
  try {
    const { status, q, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const where = {};
    if (status && ['unpaid', 'paid', 'cancelled'].includes(status)) {
      where.status = status;
    }

    const subscriptionInclude = {
      model: Subscription,
      as: 'subscription',
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['id', 'firstName', 'lastName', 'email'],
        },
      ],
    };

    if (q) {
      subscriptionInclude.required = true;
      subscriptionInclude.include[0].where = {
        [Op.or]: [
          { firstName: { [Op.like]: `%${q}%` } },
          { lastName: { [Op.like]: `%${q}%` } },
          { email: { [Op.like]: `%${q}%` } },
        ],
      };
    }

    const { rows, count } = await SubscriptionInvoice.findAndCountAll({
      where,
      include: [subscriptionInclude],
      order: [['createdAt', 'DESC']],
      limit: limitNum,
      offset: (pageNum - 1) * limitNum,
      distinct: true,
    });

    return res.json({
      invoices: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil(count / limitNum) || 1,
      },
    });
  } catch (err) {
    return next(err);
  }
};

// Cree une facture d'abonnement pour le prestataire d'une fiche donnee
// (US-A05 / facturation). Cree l'abonnement Starter par defaut si absent.
exports.createSubscriptionInvoice = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { amount, status, issuedAt, dueDate } = req.body;

  try {
    const listing = await Listing.findByPk(req.params.id);
    if (!listing) {
      return res.status(404).json({ message: 'Fiche introuvable.' });
    }

    const [subscription] = await Subscription.findOrCreate({
      where: { userId: listing.userId },
      defaults: {
        userId: listing.userId,
        plan: 'starter',
        price: PLAN_CATALOG.starter.price,
        billingCycle: 'monthly',
        status: 'active',
        startDate: new Date().toISOString().slice(0, 10),
        endDate: null,
      },
    });

    const number = await generateInvoiceNumber();
    const invoice = await SubscriptionInvoice.create({
      subscriptionId: subscription.id,
      number,
      amount,
      status: status || 'unpaid',
      issuedAt: issuedAt || new Date().toISOString().slice(0, 10),
      dueDate: dueDate || null,
      // Toujours les dates de l'abonnement facture, jamais une saisie libre.
      periodStart: subscription.startDate || null,
      periodEnd: subscription.endDate || null,
    });

    const owner = await User.findByPk(listing.userId);
    invoice.pdfUrl = await pdfService.generateSubscriptionInvoicePdf(invoice, subscription, owner);
    await invoice.save();

    return res.status(201).json(invoice);
  } catch (err) {
    return next(err);
  }
};

exports.updateSubscriptionInvoice = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { amount, status, issuedAt, dueDate } = req.body;

  try {
    const invoice = await SubscriptionInvoice.findByPk(req.params.id, {
      include: [{ model: Subscription, as: 'subscription' }],
    });
    if (!invoice) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }

    if (amount !== undefined) invoice.amount = amount;
    if (status !== undefined) invoice.status = status;
    if (issuedAt !== undefined) invoice.issuedAt = issuedAt;
    if (dueDate !== undefined) invoice.dueDate = dueDate;

    // Facture creee avant l'ajout de la periode : on la complete avec les
    // dates de son abonnement (une periode deja figee n'est jamais ecrasee).
    if (!invoice.periodStart && invoice.subscription) {
      invoice.periodStart = invoice.subscription.startDate || null;
      invoice.periodEnd = invoice.subscription.endDate || null;
    }

    // Le PDF suit les modifications (montant, dates, statut) - auparavant il
    // restait fige sur la version de creation.
    if (invoice.subscription) {
      const owner = await User.findByPk(invoice.subscription.userId);
      if (owner) {
        invoice.pdfUrl = await pdfService.generateSubscriptionInvoicePdf(invoice, invoice.subscription, owner);
      }
    }

    await invoice.save();

    return res.json(invoice);
  } catch (err) {
    return next(err);
  }
};

// Envoie la facture d'abonnement par email au prestataire concerne (SMTP
// plateforme, jamais celui du prestataire - voir emailService.sendSubscription
// InvoiceEmail). Reservee au Super Admin, meme niveau que creer/modifier/
// supprimer une facture d'abonnement (action financiere).
exports.sendSubscriptionInvoice = async (req, res, next) => {
  try {
    const invoice = await SubscriptionInvoice.findByPk(req.params.id, {
      include: [
        {
          model: Subscription,
          as: 'subscription',
          include: [{ model: User, as: 'provider', attributes: ['id', 'firstName', 'lastName', 'email'] }],
        },
      ],
    });
    if (!invoice) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }

    const owner = invoice.subscription?.provider;
    if (!owner?.email) {
      return res.status(400).json({ message: "Ce prestataire n'a pas d'adresse email enregistrée." });
    }

    await emailService.sendSubscriptionInvoiceEmail(owner, invoice, invoice.pdfUrl);

    return res.json({ message: 'Facture envoyée au prestataire.', invoice });
  } catch (err) {
    return next(err);
  }
};

exports.deleteSubscriptionInvoice = async (req, res, next) => {
  try {
    const invoice = await SubscriptionInvoice.findByPk(req.params.id);
    if (!invoice) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }

    await invoice.destroy();
    return res.json({ message: 'Facture supprimée.' });
  } catch (err) {
    return next(err);
  }
};
