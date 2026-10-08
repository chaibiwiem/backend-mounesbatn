// Villes/regions selectionnables (filtres de recherche, ville a l'inscription
// prestataire) - liste geree par l'admin (M10) au lieu du tableau statique
// TUNISIAN_CITIES d'origine. `listings.city` reste une simple chaine (pas de
// FK) : supprimer une ville ici n'affecte jamais les fiches existantes, juste
// les listes deroulantes futures.
module.exports = (sequelize, DataTypes) => {
  const City = sequelize.define(
    'City',
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      tableName: 'cities',
      timestamps: false,
    }
  );

  return City;
};
