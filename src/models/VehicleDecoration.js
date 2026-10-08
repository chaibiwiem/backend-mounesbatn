module.exports = (sequelize, DataTypes) => {
  const VehicleDecoration = sequelize.define(
    'VehicleDecoration',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      vehicleId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.TEXT },
      imageUrl: { type: DataTypes.STRING(255) },
      price: { type: DataTypes.DECIMAL(10, 2) },
      // Retrait = soft delete (isAvailable=false), jamais de suppression
      // definitive - meme logique que Vehicle.isAvailable.
      isAvailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      tableName: 'vehicle_decorations',
    }
  );

  VehicleDecoration.associate = (models) => {
    VehicleDecoration.belongsTo(models.Vehicle, { foreignKey: 'vehicleId', as: 'vehicle' });
    VehicleDecoration.hasMany(models.Lead, { foreignKey: 'decorationId', as: 'leads' });
  };

  return VehicleDecoration;
};
