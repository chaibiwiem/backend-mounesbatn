const path = require('path');
const fs = require('fs');
const db = require('../models');

const { Invoice, Contract, SubscriptionInvoice, CommissionInvoice, Listing, Subscription } = db;

const DOCUMENTS_DIR = path.join(__dirname, '../../uploads/documents');

// PDF de facture/contrat (donnees personnelles : nom, telephone, adresse et
// montants du client) - plus servi par le dossier statique public
// /uploads/documents (voir app.js) : seul le prestataire proprietaire du
// document, ou un admin, peut le telecharger. Le document est retrouve par
// son pdfUrl dans les 4 tables qui en generent.
async function findDocumentOwnerId(pdfUrl) {
  const byListing = [Invoice, Contract, CommissionInvoice];
  for (const Model of byListing) {
    const doc = await Model.findOne({
      where: { pdfUrl },
      include: [{ model: Listing, as: 'listing', attributes: ['userId'], paranoid: false }],
    });
    if (doc) return { found: true, ownerId: doc.listing?.userId ?? null };
  }

  const subscriptionInvoice = await SubscriptionInvoice.findOne({
    where: { pdfUrl },
    include: [{ model: Subscription, as: 'subscription', attributes: ['userId'] }],
  });
  if (subscriptionInvoice) return { found: true, ownerId: subscriptionInvoice.subscription?.userId ?? null };

  return { found: false, ownerId: null };
}

exports.getDocument = async (req, res, next) => {
  try {
    // basename : aucun "../" ne peut sortir du dossier des documents.
    const filename = path.basename(req.params.filename);
    if (!/^[a-f0-9]{32}\.pdf$/.test(filename)) {
      return res.status(404).json({ message: 'Document introuvable.' });
    }

    const { found, ownerId } = await findDocumentOwnerId(`/uploads/documents/${filename}`);
    const filePath = path.join(DOCUMENTS_DIR, filename);
    if (!found || !fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'Document introuvable.' });
    }
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ message: 'Accès interdit.' });
    }

    res.set('Cache-Control', 'private, no-store');
    res.type('application/pdf');
    return res.sendFile(filePath);
  } catch (err) {
    return next(err);
  }
};
