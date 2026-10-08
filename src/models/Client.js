module.exports = (sequelize, DataTypes) => {
  const Client = sequelize.define(
    'Client',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      userId: { type: DataTypes.BIGINT.UNSIGNED },
      name: { type: DataTypes.STRING(160), allowNull: false },
      phone: { type: DataTypes.STRING(20) },
      email: { type: DataTypes.STRING(160) },
      totalAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.0 },
      depositAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.0 },
      eventsCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      tag: {
        type: DataTypes.ENUM('nouveau', 'recurrent', 'vip'),
        allowNull: false,
        defaultValue: 'nouveau',
      },
      tagManual: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      notes: { type: DataTypes.TEXT },
    },
    {
      tableName: 'clients',
    }
  );

  Client.associate = (models) => {
    Client.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'provider' });
    Client.belongsTo(models.User, { foreignKey: 'userId', as: 'account' });
    Client.hasMany(models.Booking, { foreignKey: 'clientId', as: 'bookings' });
    Client.hasMany(models.Contract, { foreignKey: 'clientId', as: 'contracts' });
    Client.hasMany(models.Invoice, { foreignKey: 'clientId', as: 'invoices' });
  };

  return Client;
};
