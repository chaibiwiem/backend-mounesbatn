const { validationResult } = require('express-validator');
const db = require('../models');
const pdfService = require('../services/pdfService');
const emailService = require('../services/emailService');

const { Contract, Listing, Client } = db;
const VALID_STATUSES = ['draft', 'sent', 'signed', 'cancelled'];

async function getOwnListing(req, res) {
  const listing = await Listing.findOne({ where: { userId: req.user.id } });
  if (!listing) {
    res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    return null;
  }
  return listing;
}

exports.getContracts = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const contracts = await Contract.findAll({
      where: { listingId: listing.id },
      include: [{ model: Client, as: 'client', attributes: ['id', 'name', 'email', 'phone'] }],
      order: [['createdAt', 'DESC']],
    });

    return res.json(contracts);
  } catch (err) {
    return next(err);
  }
};

exports.createContract = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const { clientId, object, amount, deposit, paymentMode, terms } = req.body;

    let client = null;
    if (clientId) {
      client = await Client.findOne({ where: { id: clientId, listingId: listing.id } });
      if (!client) {
        return res.status(404).json({ message: 'Client introuvable.' });
      }
    }

    const contract = await Contract.create({
      listingId: listing.id,
      clientId: client ? client.id : null,
      object,
      amount,
      deposit,
      paymentMode,
      terms,
      status: 'draft',
    });

    contract.pdfUrl = await pdfService.generateContractPdf(contract, listing, client);
    await contract.save();

    return res.status(201).json(contract);
  } catch (err) {
    return next(err);
  }
};

exports.updateContract = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const contract = await Contract.findOne({
      where: { id: req.params.id, listingId: listing.id },
      include: [{ model: Client, as: 'client' }],
    });
    if (!contract) {
      return res.status(404).json({ message: 'Contrat introuvable.' });
    }

    const { object, amount, deposit, paymentMode, terms, status } = req.body;
    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ message: 'Statut invalide.' });
      }
      contract.status = status;
    }
    if (object !== undefined) contract.object = object;
    if (amount !== undefined) contract.amount = amount;
    if (deposit !== undefined) contract.deposit = deposit;
    if (paymentMode !== undefined) contract.paymentMode = paymentMode;
    if (terms !== undefined) contract.terms = terms;

    // Le contenu du PDF suit les modifications tant que le contrat n'est
    // pas signé/annulé (archive figée au-delà).
    if (!['signed', 'cancelled'].includes(contract.status)) {
      contract.pdfUrl = await pdfService.generateContractPdf(contract, listing, contract.client);
    }

    await contract.save();
    return res.json(contract);
  } catch (err) {
    return next(err);
  }
};

exports.sendContract = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const contract = await Contract.findOne({
      where: { id: req.params.id, listingId: listing.id },
      include: [{ model: Client, as: 'client' }],
    });
    if (!contract) {
      return res.status(404).json({ message: 'Contrat introuvable.' });
    }

    await emailService.sendContractEmail(contract.client, contract, listing, contract.pdfUrl);

    if (contract.status === 'draft') {
      contract.status = 'sent';
      await contract.save();
    }

    return res.json({ message: 'Contrat envoyé au client.', contract });
  } catch (err) {
    return next(err);
  }
};
