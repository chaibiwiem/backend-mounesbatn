module.exports = (sequelize, DataTypes) => {
  const Package = sequelize.define(
    'Package',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.TEXT },
      price: { type: DataTypes.DECIMAL(10, 2) },
      priceType: {
        type: DataTypes.ENUM('fixed', 'from', 'per_hour', 'on_quote'),
        allowNull: false,
        defaultValue: 'from',
      },
      duration: { type: DataTypes.STRING(80) },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'packages',
      timestamps: false,
    }
  );

  Package.associate = (models) => {
    Package.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
  };

  return Package;
};
