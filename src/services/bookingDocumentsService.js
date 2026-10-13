const { Op } = require('sequelize');
const db = require('../models');
const pdfService = require('./pdfService');
const { stayNights, formatFrDate } = require('../utils/stay');

const { Invoice, Contract, Listing, Client } = db;

// Description automatique d'une facture liee a une reservation - meme texte
// que le frontend (InvoiceBookingSelect.bookingInvoiceDescription).
function bookingInvoiceDescription(booking) {
  if (booking.checkInDate && booking.checkOutDate) {
    const nights = stayNights(booking.checkInDate, booking.checkOutDate).length;
    return `Hébergement (${nights} nuit${nights > 1 ? 's' : ''})`;
  }
  return `Prestation — événement du ${formatFrDate(booking.eventDate)}`;
}

const SCHEDULE_FIELDS = ['eventDate', 'startTime', 'endTime', 'checkInDate', 'checkOutDate'];

function scheduleSnapshot(booking) {
  return Object.fromEntries(SCHEDULE_FIELDS.map((field) => [field, booking[field] ?? null]));
}

// Reservation deplacee (date, heures, arrivee/depart) : ses factures non
// annulees et ses contrats en brouillon/envoyes suivent automatiquement - PDF
// regenere avec la nouvelle date, description automatique de facture mise a
// jour (une description saisie a la main est conservee). Un contrat signe ou
// annule reste une archive figee (meme regle que contractController). `previous` : scheduleSnapshot
// pris AVANT la modification. Renvoie le nombre de documents mis a jour.
async function syncDocumentsWithBooking(booking, previous) {
  const changed = SCHEDULE_FIELDS.some((field) => String(previous[field] ?? '') !== String(booking[field] ?? ''));
  if (!changed) return { invoices: 0, contracts: 0 };

  const [invoices, contracts] = await Promise.all([
    Invoice.findAll({ where: { bookingId: booking.id, status: { [Op.ne]: 'cancelled' } } }),
    Contract.findAll({ where: { bookingId: booking.id, status: ['draft', 'sent'] } }),
  ]);
  if (invoices.length === 0 && contracts.length === 0) return { invoices: 0, contracts: 0 };

  const listing = await Listing.findByPk(booking.listingId, { paranoid: false });
  const clients = new Map();
  const clientFor = async (id) => {
    if (!id) return null;
    if (!clients.has(id)) clients.set(id, await Client.findByPk(id));
    return clients.get(id);
  };

  const oldDescription = bookingInvoiceDescription(previous);
  for (const invoice of invoices) {
    if (!invoice.description || invoice.description === oldDescription) {
      invoice.description = bookingInvoiceDescription(booking);
    }
    invoice.pdfUrl = await pdfService.generateInvoicePdf(invoice, listing, await clientFor(invoice.clientId), booking);
    await invoice.save();
  }
  for (const contract of contracts) {
    contract.pdfUrl = await pdfService.generateContractPdf(contract, listing, await clientFor(contract.clientId), booking);
    await contract.save();
  }
  return { invoices: invoices.length, contracts: contracts.length };
}

module.exports = { syncDocumentsWithBooking, scheduleSnapshot, bookingInvoiceDescription };
