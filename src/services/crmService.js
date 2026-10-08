const { Op } = require('sequelize');
const db = require('../models');

const { Client, Booking, VehicleBooking } = db;
const VIP_AMOUNT_THRESHOLD = 5000;

// Règles de gestion 2.9 du cahier des charges / CLAUDE.md :
// Nouveau (1 événement), Récurrent (2+), VIP (3+ OU montant déclaré > 5000 DT).
function computeTag(client) {
  if (client.eventsCount >= 3 || Number(client.totalAmount) > VIP_AMOUNT_THRESHOLD) {
    return 'vip';
  }
  if (client.eventsCount >= 2) {
    return 'recurrent';
  }
  return 'nouveau';
}

// Fiche client auto-créée à chaque demande de devis (US-P07), identifiée par
// email au sein d'une même fiche prestataire.
async function findOrCreateClientForLead(lead, listing) {
  const [client] = await Client.findOrCreate({
    where: { listingId: listing.id, email: lead.email },
    defaults: {
      listingId: listing.id,
      userId: lead.userId,
      name: `${lead.firstName} ${lead.lastName}`,
      phone: lead.phone,
      email: lead.email,
    },
  });
  return client;
}

// Un lead converti trace un événement réel : incrémente le compteur et
// recalcule le tag (sauf surcharge manuelle explicite).
async function registerConvertedEvent(client) {
  client.eventsCount += 1;
  if (!client.tagManual) {
    client.tag = computeTag(client);
  }
  await client.save();
  return client;
}

// Recalcule montant total + acompte declares (CLAUDE.md - montants
// declaratifs, jamais un paiement traite par la plateforme) a partir des
// reservations non annulees du client - Booking (generique) ET VehicleBooking
// (prestataires Transport, cf. transportService), plutot que de les cumuler
// incrementalement : toute reservation creee/modifiee/annulee reste
// coherente d'un seul appel, sans risque de desynchronisation. Reste
// modifiable a la main ensuite (ClientEditModal) - une correction manuelle
// est cependant ecrasee par le prochain recalcul declenche par une
// reservation.
async function recalculateClientFinancials(client) {
  const [bookings, vehicleBookings] = await Promise.all([
    Booking.findAll({
      where: { clientId: client.id, status: { [Op.ne]: 'cancelled' } },
      attributes: ['totalPrice', 'deposit'],
    }),
    VehicleBooking.findAll({
      where: { clientId: client.id, status: { [Op.ne]: 'cancelled' } },
      attributes: ['totalPrice', 'deposit'],
    }),
  ]);
  const all = [...bookings, ...vehicleBookings];
  client.totalAmount = all.reduce((sum, b) => sum + Number(b.totalPrice || 0), 0);
  client.depositAmount = all.reduce((sum, b) => sum + Number(b.deposit || 0), 0);
  if (!client.tagManual) {
    client.tag = computeTag(client);
  }
  await client.save();
  return client;
}

// Recalcule events_count a partir des reservations non annulees restantes
// (Booking + VehicleBooking), contrairement a registerConvertedEvent
// (incremental, jamais decremente) - utilise uniquement lors de la
// suppression d'une reservation (calendrier M5), pour ne pas laisser un
// compteur/tag CRM obsolete apres coup.
async function recalculateClientEventsCount(client) {
  const [bookingsCount, vehicleBookingsCount] = await Promise.all([
    Booking.count({ where: { clientId: client.id, status: { [Op.ne]: 'cancelled' } } }),
    VehicleBooking.count({ where: { clientId: client.id, status: { [Op.ne]: 'cancelled' } } }),
  ]);
  client.eventsCount = bookingsCount + vehicleBookingsCount;
  if (!client.tagManual) {
    client.tag = computeTag(client);
  }
  await client.save();
  return client;
}

module.exports = {
  computeTag,
  findOrCreateClientForLead,
  registerConvertedEvent,
  recalculateClientFinancials,
  recalculateClientEventsCount,
};
