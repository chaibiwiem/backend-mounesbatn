const cron = require('node-cron');
const { Op } = require('sequelize');
const db = require('../models');

const { Lead } = db;
const LATE_AFTER_MS = 48 * 60 * 60 * 1000;

// Fait passer tout lead 'new' de plus de 48h au statut 'late' (US-P06,
// CLAUDE.md - regle metier). Exportee separement du schedule() pour etre
// testable sans attendre un vrai cron.
async function markLateLeads() {
  const [count] = await Lead.update(
    { status: 'late' },
    {
      where: {
        status: 'new',
        createdAt: { [Op.lte]: new Date(Date.now() - LATE_AFTER_MS) },
      },
    }
  );
  return count;
}

function start() {
  // Toutes les heures : suffisant pour une fenetre de 48h, evite de
  // surcharger la base inutilement.
  return cron.schedule('0 * * * *', () => {
    markLateLeads().catch((err) => {
      console.error('Echec de la tache cron markLateLeads :', err.message);
    });
  });
}

module.exports = { start, markLateLeads };
