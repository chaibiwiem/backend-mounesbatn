require('dotenv').config();

const app = require('./src/app');
const leadCronService = require('./src/services/leadCronService');
const subscriptionCronService = require('./src/services/subscriptionCronService');
const commissionCronService = require('./src/services/commissionCronService');
const planService = require('./src/services/planService');

const PORT = process.env.PORT || 5000;

// Filet de securite : depuis Node 15, une promesse rejetee jamais attrapee
// (ex. tache lancee sans await) arrete tout le serveur. On la journalise et
// le site continue de repondre.
process.on('unhandledRejection', (reason) => {
  console.error('Promesse rejetee non geree :', reason);
});

// Exception synchrone non attrapee : l'etat du processus n'est plus fiable,
// on journalise puis on quitte proprement - PM2 relance automatiquement le
// serveur en production.
process.on('uncaughtException', (err) => {
  console.error('Exception non geree, redemarrage du serveur :', err);
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`Mounesba API en ecoute sur le port ${PORT}`);
});

leadCronService.start();
subscriptionCronService.start();
commissionCronService.start();

// Ecrase les valeurs par defaut de PLAN_CATALOG avec celles enregistrees en
// base (Parametres admin > Plans & Tarifs) - echec non bloquant (ex. table
// pas encore migree) : le catalogue garde alors ses valeurs par defaut.
planService.loadPlansFromDb().catch((err) => {
  console.error('Impossible de charger les plans depuis la base :', err.message);
});

module.exports = app;
