const path = require('path');
const fs = require('fs');
const db = require('../models');
const pdfService = require('../services/pdfService');
const DOCUMENTS_DIR = require('../config/documentsDir');

const { Invoice, Contract, SubscriptionInvoice, CommissionInvoice, Commission, Lead, Listing, Subscription, User } = db;

const LISTING_WITH_OWNER = {
  model: Listing,
  as: 'listing',
  paranoid: false,
  include: [{ model: User, as: 'owner', attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] }],
};

// Chaque type de document : comment le retrouver par son pdfUrl, qui en est
// proprietaire, et comment regenerer son PDF a l'identique (meme nom de
// fichier) s'il n'existe plus sur disque - cas normal sur Vercel, ou /tmp est
// vide a chaque nouvelle instance.
const DOCUMENT_TYPES = [
  {
    model: Invoice,
    include: [LISTING_WITH_OWNER, 'client', 'booking'],
    ownerId: (doc) => doc.listing?.userId ?? null,
    regenerate: (doc, filename) =>
      pdfService.generateInvoicePdf(doc, doc.listing, doc.client, doc.booking || null, { filename }),
  },
  {
    model: Contract,
    include: [LISTING_WITH_OWNER, 'client', 'booking'],
    ownerId: (doc) => doc.listing?.userId ?? null,
    regenerate: (doc, filename) =>
      pdfService.generateContractPdf(doc, doc.listing, doc.client, doc.booking || null, { filename }),
  },
  {
    model: CommissionInvoice,
    include: [
      LISTING_WITH_OWNER,
      { model: Commission, as: 'commissions', include: [{ model: Lead, as: 'lead', attributes: ['id', 'firstName', 'lastName'] }] },
    ],
    ownerId: (doc) => doc.listing?.userId ?? null,
    regenerate: (doc, filename) => {
      const lines = [...(doc.commissions || [])].sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
      return pdfService.generateCommissionInvoicePdf(doc, doc.listing, doc.listing?.owner, lines, { filename });
    },
  },
  {
    model: SubscriptionInvoice,
    include: [{ model: Subscription, as: 'subscription' }],
    ownerId: (doc) => doc.subscription?.userId ?? null,
    regenerate: async (doc, filename) => {
      const owner = doc.subscription ? await User.findByPk(doc.subscription.userId) : null;
      if (!owner) throw new Error('Proprietaire de l\'abonnement introuvable');
      return pdfService.generateSubscriptionInvoicePdf(doc, doc.subscription, owner, { filename });
    },
  },
];

// PDF de facture/contrat (donnees personnelles : nom, telephone, adresse et
// montants du client) - plus servi par le dossier statique public
// /uploads/documents (voir app.js) : seul le prestataire proprietaire du
// document, ou un admin, peut le telecharger.
async function findDocument(pdfUrl) {
  for (const type of DOCUMENT_TYPES) {
    const doc = await type.model.findOne({ where: { pdfUrl }, include: type.include });
    if (doc) return { type, doc };
  }
  return null;
}

exports.getDocument = async (req, res, next) => {
  try {
    // basename : aucun "../" ne peut sortir du dossier des documents.
    const filename = path.basename(req.params.filename);
    if (!/^[a-f0-9]{32}\.pdf$/.test(filename)) {
      return res.status(404).json({ message: 'Document introuvable.' });
    }

    const found = await findDocument(`/uploads/documents/${filename}`);
    if (!found) {
      return res.status(404).json({ message: 'Document introuvable.' });
    }
    if (req.user.role !== 'admin' && found.type.ownerId(found.doc) !== req.user.id) {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    const filePath = path.join(DOCUMENTS_DIR, filename);
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
      await found.type.regenerate(found.doc, filename);
    }

    res.set('Cache-Control', 'private, no-store');
    res.type('application/pdf');
    return res.sendFile(filePath);
  } catch (err) {
    return next(err);
  }
};
