// Sous-categories SUPPLEMENTAIRES d'une fiche prestataire, en plus de sa
// sous-categorie d'inscription (Listing.categoryId, toujours la 1re). Leur
// nombre est limite par le plan (Plan.maxCategories, qui compte la categorie
// d'inscription) - voir listingController.updateMyCategories pour l'ajout et
// listingController.extraCategoryClause pour la prise en compte en recherche.
module.exports = (sequelize, DataTypes) => {
  const ListingCategory = sequelize.define(
    'ListingCategory',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      categoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    },
    {
      tableName: 'listing_categories',
      updatedAt: false,
      indexes: [{ unique: true, fields: ['listing_id', 'category_id'] }],
    }
  );

  ListingCategory.associate = (models) => {
    ListingCategory.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
    ListingCategory.belongsTo(models.Category, { foreignKey: 'categoryId', as: 'category' });
  };

  return ListingCategory;
};
