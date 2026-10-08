module.exports = (sequelize, DataTypes) => {
  const Contract = sequelize.define(
    'Contract',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      clientId: { type: DataTypes.BIGINT.UNSIGNED },
      object: { type: DataTypes.STRING(200), allowNull: false },
      amount: { type: DataTypes.DECIMAL(12, 2) },
      deposit: { type: DataTypes.DECIMAL(12, 2) },
      paymentMode: { type: DataTypes.ENUM('cash', 'rib') },
      terms: { type: DataTypes.TEXT },
      status: {
        type: DataTypes.ENUM('draft', 'sent', 'signed', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      pdfUrl: { type: DataTypes.STRING(255) },
    },
    {
      tableName: 'contracts',
    }
  );

  Contract.associate = (models) => {
    Contract.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
    Contract.belongsTo(models.Client, { foreignKey: 'clientId', as: 'client' });
  };

  return Contract;
};
