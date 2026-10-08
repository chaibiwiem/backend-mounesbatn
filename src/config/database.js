const { Sequelize } = require('sequelize');

require('dotenv').config();

const sequelizeOptions = {
  dialect: 'mysql',
  // Import explicite : sur Vercel, le require dynamique de Sequelize n'est pas
  // detecte par le bundler et mysql2 manque dans la fonction deployee.
  dialectModule: require('mysql2'),
  logging: false,
  define: {
    underscored: true,
    timestamps: true,
  },
};

// Accepte soit une DATABASE_URL unique, soit des variables DB_HOST/DB_PORT/
// DB_USER/DB_PASS/DB_NAME separees (les deux styles cohabitent selon les .env).
const sequelize = process.env.DATABASE_URL
  ? new Sequelize(process.env.DATABASE_URL, sequelizeOptions)
  : new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
      ...sequelizeOptions,
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
    });

module.exports = sequelize;
