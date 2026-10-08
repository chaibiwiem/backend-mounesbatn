// Services complementaires a un type d'evenement (ex. "Location de salle de
// conference" pour "Evenements professionnels") - purement informatif, ce ne
// sont PAS des sous-categories de prestataires (aucun listing n'y est
// rattache), juste une liste geree par l'admin pour eclairer le visiteur sur
// ce qu'il pourrait aussi avoir besoin d'organiser. Bilingue FR/AR : seul
// contenu bilingue de la plateforme, propre a cette liste.
module.exports = (sequelize, DataTypes) => {
  const AssociatedService = sequelize.define(
    'AssociatedService',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      categoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      nameFr: { type: DataTypes.STRING(160), allowNull: false },
      nameAr: { type: DataTypes.STRING(160) },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'associated_services',
      timestamps: false,
    }
  );

  AssociatedService.associate = (models) => {
    AssociatedService.belongsTo(models.Category, { foreignKey: 'categoryId', as: 'category' });
  };

  return AssociatedService;
};
