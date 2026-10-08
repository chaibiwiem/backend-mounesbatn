const { Op } = require('sequelize');
const { validationResult } = require('express-validator');
const db = require('../models');
const crmService = require('../services/crmService');

const { Client, Listing, Booking, Contract, Invoice } = db;
const VALID_TAGS = ['nouveau', 'recurrent', 'vip'];

async function getOwnListing(req, res) {
  const listing = await Listing.findOne({ where: { userId: req.user.id } });
  if (!listing) {
    res.status(404).json({ message: 'Aucune fiche prestataire associée à votre compte.' });
    return null;
  }
  return listing;
}

exports.getClients = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const { tag, q } = req.query;
    const where = { listingId: listing.id };
    if (tag) where.tag = tag;
    if (q) {
      where[Op.or] = [
        { name: { [Op.like]: `%${q}%` } },
        { email: { [Op.like]: `%${q}%` } },
        { phone: { [Op.like]: `%${q}%` } },
      ];
    }

    const clients = await Client.findAll({ where, order: [['updatedAt', 'DESC']] });
    return res.json(clients);
  } catch (err) {
    return next(err);
  }
};

exports.exportClients = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const clients = await Client.findAll({
      where: { listingId: listing.id },
      order: [['name', 'ASC']],
    });

    const escape = (value) => `"${String(value ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
    const header = ['Nom', 'Email', 'Téléphone', 'Événements', 'Montant total', 'Acompte', 'Tag', 'Notes'].join(',');
    const rows = clients.map((c) =>
      [c.name, c.email, c.phone, c.eventsCount, c.totalAmount, c.depositAmount, c.tag, c.notes]
        .map(escape)
        .join(',')
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clients.csv"');
    return res.send([header, ...rows].join('\n'));
  } catch (err) {
    return next(err);
  }
};

exports.getClient = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    // Historique des reservations du client (fiche detail CRM), avec le
    // detail du sejour pour les "Maisons d'hotes" (Arrivee/Depart/chambres).
    const client = await Client.findOne({
      where: { id: req.params.id, listingId: listing.id },
      include: [
        {
          model: Booking,
          as: 'bookings',
          attributes: [
            'id',
            'eventDate',
            'status',
            'totalPrice',
            'deposit',
            'checkInDate',
            'checkOutDate',
            'rooms',
            'guests',
          ],
        },
      ],
      order: [[{ model: Booking, as: 'bookings' }, 'eventDate', 'DESC']],
    });
    if (!client) {
      return res.status(404).json({ message: 'Client introuvable.' });
    }

    return res.json(client);
  } catch (err) {
    return next(err);
  }
};

exports.updateClient = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const client = await Client.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!client) {
      return res.status(404).json({ message: 'Client introuvable.' });
    }

    const { totalAmount, depositAmount, tag, notes } = req.body;

    if (tag !== undefined) {
      if (!VALID_TAGS.includes(tag)) {
        return res.status(400).json({ message: 'Tag invalide.' });
      }
      // Surcharge manuelle explicite (US-P07) : le recalcul automatique ne
      // remplacera plus ce tag tant qu'il n'est pas levé.
      client.tag = tag;
      client.tagManual = true;
    }

    if (totalAmount !== undefined) {
      client.totalAmount = totalAmount;
      if (!client.tagManual) {
        client.tag = crmService.computeTag(client);
      }
    }

    if (depositAmount !== undefined) client.depositAmount = depositAmount;

    if (notes !== undefined) client.notes = notes;

    await client.save();
    return res.json(client);
  } catch (err) {
    return next(err);
  }
};

// Suppression bloquee si le client a un historique reel (booking, contrat ou
// facture liee) : on perdrait sinon la tracabilite de ces documents/evenements
// declaratifs (CLAUDE.md - aucune donnee ne doit disparaitre silencieusement).
exports.deleteClient = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const client = await Client.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!client) {
      return res.status(404).json({ message: 'Client introuvable.' });
    }

    const [bookingsCount, contractsCount, invoicesCount] = await Promise.all([
      Booking.count({ where: { clientId: client.id } }),
      Contract.count({ where: { clientId: client.id } }),
      Invoice.count({ where: { clientId: client.id } }),
    ]);

    if (bookingsCount > 0 || contractsCount > 0 || invoicesCount > 0) {
      return res.status(409).json({
        message:
          'Impossible de supprimer ce client : il a des réservations, contrats ou factures associés.',
      });
    }

    await client.destroy();
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
};

exports.clearManualTag = async (req, res, next) => {
  try {
    const listing = await getOwnListing(req, res);
    if (!listing) return;

    const client = await Client.findOne({ where: { id: req.params.id, listingId: listing.id } });
    if (!client) {
      return res.status(404).json({ message: 'Client introuvable.' });
    }

    client.tagManual = false;
    client.tag = crmService.computeTag(client);
    await client.save();

    return res.json(client);
  } catch (err) {
    return next(err);
  }
};
