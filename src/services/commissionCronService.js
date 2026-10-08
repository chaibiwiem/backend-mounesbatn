const cron = require('node-cron');
const { Op } = require('sequelize');
const db = require('../models');
const emailService = require('./emailService');
const { REALIZED_STATUSES } = require('./connectionFeeService');

const { Commission, Lead, Listing, Booking } = db;

const today = () => new Date().toISOString().slice(0, 10);

// Invitation du client a laisser un avis verifie (M13 - incitation a
// confirmer) : une seule fois, apres double confirmation (statut
// validated/invoiced/paid) et une fois la date de l'evenement passee. La
// reservation issue de la demande passe "terminee" (condition d'un avis
// verifie, M8) : l'evenement a eu lieu et la plateforme l'a valide.
async function sendReviewInviteIfDue(commission) {
  if (!REALIZED_STATUSES.includes(commission.status) || commission.reviewInviteSentAt) return false;
  const lead = await Lead.findByPk(commission.leadId);
  const eventDate = commission.eventDate || lead?.eventDate || lead?.checkInDate;
  if (!lead || !eventDate || eventDate > today()) return false;

  const booking = await Booking.findOne({ where: { leadId: lead.id } });
  if (booking?.status === 'cancelled') return false;
  if (booking && ['pending', 'confirmed'].includes(booking.status)) {
    booking.status = 'completed';
    await booking.save();
  }

  const listing = await Listing.findByPk(commission.listingId);
  await emailService.sendReviewInvitationEmail(lead, listing, { hasAccount: Boolean(lead.userId) });
  commission.reviewInviteSentAt = new Date();
  await commission.save();
  return true;
}

// Lignes validees dont l'evenement est passe depuis la validation
// (evenements a venir au moment de la validation admin).
async function sendDueReviewInvites() {
  const due = await Commission.findAll({
    where: {
      status: REALIZED_STATUSES,
      reviewInviteSentAt: null,
      eventDate: { [Op.lte]: today() },
    },
  });
  let sent = 0;
  for (const commission of due) {
    if (await sendReviewInviteIfDue(commission)) sent += 1;
  }
  return sent;
}

function start() {
  // Une fois par jour, en matinee.
  return cron.schedule('0 9 * * *', () => {
    sendDueReviewInvites().catch((err) => {
      console.error('Echec de la tache cron sendDueReviewInvites :', err.message);
    });
  });
}

module.exports = { start, sendReviewInviteIfDue, sendDueReviewInvites };
