const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const db = require('../models');
const pdfService = require('../services/pdfService');
const emailService = require('../services/emailService');
const { computeInvoiceTotals } = require('../utils/invoiceTotals');

const { Invoice, Listing, Client, Booking } = db;

// L'acompte ne peut jamais depasser le total TTC (le reste a payer serait
// negatif) - renvoie le message d'erreur, ou null si coherent.
function depositError(invoiceLike) {
  const { ttc, deposit } = computeInvoiceTotals(invoiceLike);
  if (deposit > ttc) {
    return `L'acompte (${deposit} DT) ne peut pas dépasser le total TTC (${ttc} DT).`;
  }
  return null;
}
const VALID_STATUSES = ['unpaid', 'paid', 'cancelled'];

async function getOwnListing(req, res) {
  const listing = await Listing.findOne({ where: { userId: req.user.id } });
  if (!listing) {
    res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    return null;
  }
  return listing;
}

// Numérotation séquentielle par prestataire et par année (ex: FAC-2026-0001) —
// respecte la contrainte unique (listing_id, number) du schéma.
// Reservation facturee (optionnelle) : doit appartenir a la fiche du
// prestataire. Renvoie undefined si non fournie, null si explicitement retiree.
async function resolveBooking(bookingId, listingId, res) {
  if (bookingId === undefined) return undefined;
  if (!bookingId) return null;
  const booking = await Booking.findOne({ where: { id: bookingId, listingId } });
  if (!booking) {
    res.status(404).json({ message: 'Réservation introuvable.' });
    return false;
  }
  return booking;
}

async function generateInvoiceNumber(listingId) {
  const year = new Date().getFullYear();
  const count = await Invoice.count({
    where: { listingId, number: { [Op.like]: `FAC-${year}-%` } },
  });
  return `FAC-${year}-${String(count + 1).padStart(4, '0')}`;
}

exports.getInvoices = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const invoices = await Invoice.findAll({
      where: { listingId: listing.id },
      include: [
        { model: Client, as: 'client', attributes: ['id', 'name', 'email', 'phone'] },
        {
          model: Booking,
          as: 'booking',
          attributes: ['id', 'eventDate', 'checkInDate', 'checkOutDate', 'rooms', 'guests', 'totalPrice', 'deposit'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    return res.json(invoices);
  } catch (err) {
    return next(err);
  }
};

exports.createInvoice = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const { clientId, bookingId, description, amount, taxRate, deposit, issuedAt } = req.body;

    const invalidDeposit = depositError({ amount, taxRate, deposit });
    if (invalidDeposit) {
      return res.status(400).json({ message: invalidDeposit });
    }

    const booking = await resolveBooking(bookingId, listing.id, res);
    if (booking === false) return;

    let client = null;
    // Sans client choisi, celui de la reservation facturee est repris.
    const targetClientId = clientId || booking?.clientId;
    if (targetClientId) {
      client = await Client.findOne({ where: { id: targetClientId, listingId: listing.id } });
      if (!client) {
        return res.status(404).json({ message: 'Client introuvable.' });
      }
    }

    const number = await generateInvoiceNumber(listing.id);

    const invoice = await Invoice.create({
      listingId: listing.id,
      clientId: client ? client.id : null,
      bookingId: booking ? booking.id : null,
      number,
      description: description || null,
      amount,
      taxRate: taxRate || null,
      deposit: deposit || null,
      issuedAt: issuedAt || new Date().toISOString().slice(0, 10),
      status: 'unpaid',
    });

    invoice.pdfUrl = await pdfService.generateInvoicePdf(invoice, listing, client, booking || null);
    await invoice.save();

    return res.status(201).json(invoice);
  } catch (err) {
    return next(err);
  }
};

exports.updateInvoice = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const invoice = await Invoice.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!invoice) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }

    const { clientId, bookingId, description, amount, taxRate, deposit, issuedAt, status } = req.body;

    const booking = await resolveBooking(bookingId, listing.id, res);
    if (booking === false) return;
    if (booking !== undefined) invoice.bookingId = booking ? booking.id : null;

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ message: 'Statut invalide.' });
      }
      invoice.status = status;
    }

    if (clientId !== undefined) {
      if (clientId) {
        const client = await Client.findOne({ where: { id: clientId, listingId: listing.id } });
        if (!client) {
          return res.status(404).json({ message: 'Client introuvable.' });
        }
        invoice.clientId = client.id;
      } else {
        invoice.clientId = null;
      }
    }

    if (description !== undefined) invoice.description = description || null;

    if (amount !== undefined) {
      if (amount === null || amount === '') {
        return res.status(400).json({ message: 'Le montant est requis.' });
      }
      invoice.amount = amount;
    }

    if (taxRate !== undefined) {
      if (taxRate !== null && taxRate !== '' && (taxRate < 0 || taxRate > 100)) {
        return res.status(400).json({ message: 'Le taux de TVA doit être compris entre 0 et 100.' });
      }
      invoice.taxRate = taxRate || null;
    }

    if (deposit !== undefined) invoice.deposit = deposit || null;

    // Verifie sur les valeurs finales (montant/TVA/acompte eventuellement
    // modifies ensemble dans la meme requete).
    const invalidDeposit = depositError(invoice);
    if (invalidDeposit) {
      return res.status(400).json({ message: invalidDeposit });
    }

    if (issuedAt !== undefined && issuedAt) {
      invoice.issuedAt = issuedAt;
    }

    // Le PDF suit les modifications tant que la facture n'est pas annulée
    // (archive figée au-delà), même logique que les contrats.
    if (invoice.status !== 'cancelled') {
      const client = invoice.clientId ? await Client.findByPk(invoice.clientId) : null;
      const linkedBooking = invoice.bookingId ? await Booking.findByPk(invoice.bookingId) : null;
      invoice.pdfUrl = await pdfService.generateInvoicePdf(invoice, listing, client, linkedBooking);
    }

    await invoice.save();
    return res.json(invoice);
  } catch (err) {
    return next(err);
  }
};

exports.updateInvoiceStatus = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const { status } = req.body;

    const invoice = await Invoice.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!invoice) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }

    invoice.status = status;
    await invoice.save();

    return res.json(invoice);
  } catch (err) {
    return next(err);
  }
};

exports.sendInvoice = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const invoice = await Invoice.findOne({
      where: { id: req.params.id, listingId: listing.id },
      include: [{ model: Client, as: 'client' }],
    });
    if (!invoice) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }

    await emailService.sendInvoiceEmail(invoice.client, invoice, listing, invoice.pdfUrl);

    return res.json({ message: 'Facture envoyée au client.', invoice });
  } catch (err) {
    return next(err);
  }
};
