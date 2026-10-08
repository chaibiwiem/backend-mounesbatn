module.exports = (sequelize, DataTypes) => {
  const VehicleBooking = sequelize.define(
    'VehicleBooking',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      vehicleId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      clientId: { type: DataTypes.BIGINT.UNSIGNED },
      leadId: { type: DataTypes.BIGINT.UNSIGNED },
      // Une location = une periode (depart/retour) - jamais sur `vehicles`,
      // qui decrit le vehicule lui-meme, reutilisable pour plusieurs locations.
      departureDatetime: { type: DataTypes.DATE, allowNull: false },
      returnDatetime: { type: DataTypes.DATE, allowNull: false },
      totalPrice: { type: DataTypes.DECIMAL(12, 2) },
      deposit: { type: DataTypes.DECIMAL(12, 2) },
      paymentMethod: { type: DataTypes.ENUM('cash', 'rib') },
      status: {
        type: DataTypes.ENUM('pending', 'confirmed', 'completed', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending',
      },
      notes: { type: DataTypes.TEXT },
    },
    {
      tableName: 'vehicle_bookings',
      updatedAt: false,
    }
  );

  VehicleBooking.associate = (models) => {
    VehicleBooking.belongsTo(models.Vehicle, { foreignKey: 'vehicleId', as: 'vehicle' });
    VehicleBooking.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
    VehicleBooking.belongsTo(models.Client, { foreignKey: 'clientId', as: 'client' });
    VehicleBooking.belongsTo(models.Lead, { foreignKey: 'leadId', as: 'lead' });
  };

  return VehicleBooking;
};
