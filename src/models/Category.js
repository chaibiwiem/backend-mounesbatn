module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define(
    'Category',
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      parentId: { type: DataTypes.INTEGER.UNSIGNED },
      name: { type: DataTypes.STRING(120), allowNull: false },
      slug: { type: DataTypes.STRING(140), allowNull: false, unique: true },
      icon: { type: DataTypes.STRING(80) },
      iconUrl: { type: DataTypes.STRING(255) },
      imageUrl: { type: DataTypes.STRING(255) },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      // Frais de mise en relation (M13) : seules les categories activees en
      // generent - forfait fixe (commission_value en DT) ou pourcentage
      // (commission_value en %) du montant du contrat declare par le
      // prestataire. Une modification ne vaut que pour les futures demandes :
      // chaque ligne `commissions` fige son tarif a sa creation.
      commissionEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      commissionType: { type: DataTypes.ENUM('fixed', 'percent') },
      commissionValue: { type: DataTypes.DECIMAL(10, 2) },
    },
    {
      tableName: 'categories',
      timestamps: false,
    }
  );

  Category.associate = (models) => {
    Category.belongsTo(models.Category, { foreignKey: 'parentId', as: 'parent' });
    Category.hasMany(models.Category, { foreignKey: 'parentId', as: 'children' });
    Category.hasMany(models.Listing, { foreignKey: 'categoryId', as: 'listings' });
    Category.hasMany(models.AssociatedService, { foreignKey: 'categoryId', as: 'associatedServices' });
    Category.hasMany(models.Commission, { foreignKey: 'categoryId', as: 'commissions' });
  };

  return Category;
};
