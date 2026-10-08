module.exports = (sequelize, DataTypes) => {
  const Availability = sequelize.define(
    'Availability',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      isAvailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      priceOverride: { type: DataTypes.DECIMAL(10, 2) },
    },
    {
      tableName: 'availability',
      timestamps: false,
      indexes: [{ unique: true, fields: ['listing_id', 'date'] }],
    }
  );

  Availability.associate = (models) => {
    Availability.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
  };

  return Availability;
};
