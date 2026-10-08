module.exports = (sequelize, DataTypes) => {
  const Promotion = sequelize.define(
    'Promotion',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      type: { type: DataTypes.ENUM('percent', 'fixed'), allowNull: false },
      value: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      label: { type: DataTypes.STRING(160), allowNull: false },
      startDate: { type: DataTypes.DATEONLY },
      endDate: { type: DataTypes.DATEONLY },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      tableName: 'promotions',
      updatedAt: false,
    }
  );

  Promotion.associate = (models) => {
    Promotion.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
  };

  return Promotion;
};
