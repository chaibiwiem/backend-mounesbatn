module.exports = (sequelize, DataTypes) => {
  const VehicleOption = sequelize.define(
    'VehicleOption',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      vehicleId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      // 'per_day' : prix x nombre de jours de location (ex. GPS 2 DT/jour).
      // 'flat' : prix forfaitaire unique quelle que soit la duree (ex. plein
      // d'essence 40 DT).
      pricingType: {
        type: DataTypes.ENUM('per_day', 'flat'),
        allowNull: false,
        defaultValue: 'per_day',
      },
      // 1 = case a cocher simple (ex. "2eme conducteur") ; >1 = quantite
      // selectionnable de 0 a maxQuantity (ex. "Siege bebe" jusqu'a 2).
      maxQuantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      // Retrait = soft delete (isAvailable=false), jamais de suppression
      // definitive - meme logique que VehicleDecoration.isAvailable.
      isAvailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      tableName: 'vehicle_options',
    }
  );

  VehicleOption.associate = (models) => {
    VehicleOption.belongsTo(models.Vehicle, { foreignKey: 'vehicleId', as: 'vehicle' });
    VehicleOption.hasMany(models.LeadOption, { foreignKey: 'vehicleOptionId', as: 'leadOptions' });
  };

  return VehicleOption;
};
