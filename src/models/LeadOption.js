module.exports = (sequelize, DataTypes) => {
  const LeadOption = sequelize.define(
    'LeadOption',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      leadId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      vehicleOptionId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      tableName: 'lead_options',
      updatedAt: false,
    }
  );

  LeadOption.associate = (models) => {
    LeadOption.belongsTo(models.Lead, { foreignKey: 'leadId', as: 'lead' });
    LeadOption.belongsTo(models.VehicleOption, { foreignKey: 'vehicleOptionId', as: 'option' });
  };

  return LeadOption;
};
