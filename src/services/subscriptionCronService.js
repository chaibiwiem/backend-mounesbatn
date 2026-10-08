const cron = require('node-cron');
const db = require('../models');
const emailService = require('./emailService');

const { Subscription, User } = db;

// Envoie le rappel J-7 avant echeance (US-P10, MODULES.md M9). Exportee
// separement de schedule() pour etre testable sans attendre un vrai cron.
async function sendExpiryReminders() {
  const inSevenDays = new Date();
  inSevenDays.setDate(inSevenDays.getDate() + 7);
  const targetDate = inSevenDays.toISOString().slice(0, 10);

  const subscriptions = await Subscription.findAll({
    where: { status: 'active', endDate: targetDate, reminderSentAt: null },
    include: [{ model: User, as: 'provider' }],
  });

  for (const subscription of subscriptions) {
    await emailService.sendSubscriptionExpiryReminderEmail(subscription.provider, subscription);
    subscription.reminderSentAt = new Date();
    await subscription.save();
  }

  return subscriptions.length;
}

function start() {
  // Une fois par jour suffit pour une echeance a J-7 (pas besoin de granularite
  // horaire comme pour les leads 'late').
  return cron.schedule('0 8 * * *', () => {
    sendExpiryReminders().catch((err) => {
      console.error('Echec de la tache cron sendExpiryReminders :', err.message);
    });
  });
}

module.exports = { start, sendExpiryReminders };
