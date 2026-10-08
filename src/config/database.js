const { Sequelize } = require('sequelize');

require('dotenv').config();

const sequelizeOptions = {
  dialect: 'mysql',
  // Import explicite : sur Vercel, le require dynamique de Sequelize n'est pas
  // detecte par le bundler et mysql2 manque dans la fonction deployee.
  dialectModule: require('mysql2'),
  logging: false,
  // Sur Vercel (serverless), chaque instance a son propre pool : avec la
  // limite de connexions des petites bases (ex. Clever Cloud Dev), un pool
  // de 5 sature vite (ER_TOO_MANY_USER_CONNECTIONS -> 500 aleatoires).
  // 1 connexion par instance, liberee des qu'elle est inactive.
  pool: process.env.VERCEL
    ? { max: Number(process.env.DB_POOL_MAX) || 1, min: 0, idle: 1000, acquire: 30000, evict: 1000 }
    : { max: Number(process.env.DB_POOL_MAX) || 5, min: 0, idle: 10000, acquire: 30000 },
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

// Une instance Vercel gelee ne ferme jamais sa connexion : sans ce reglage,
// MySQL la garde ouverte jusqu'a wait_timeout (souvent 8h) et la limite de
// connexions de la base finit saturee. Le serveur la coupe apres 60s.
if (process.env.VERCEL) {
  sequelize.addHook('afterConnect', async (connection) => {
    await connection.promise().query('SET SESSION wait_timeout = 60');
  });
}

module.exports = sequelize;
