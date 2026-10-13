const db = require('../models');

const alter = process.argv.includes('--alter');

db.sequelize
  .sync({ alter })
  .then(() => {
    console.log('Base de donnees synchronisee (tables creees/mises a jour).');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Erreur de synchronisation de la base de donnees :', err);
    process.exit(1);
  });
