module.exports = (sequelize, DataTypes) => {
  const Subscription = sequelize.define(
    'Subscription',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      plan: {
        type: DataTypes.ENUM('starter', 'pro', 'premium', 'elite'),
        allowNull: false,
        defaultValue: 'starter',
      },
      price: { type: DataTypes.DECIMAL(8, 2), allowNull: false, defaultValue: 0.0 },
      billingCycle: {
        type: DataTypes.ENUM('monthly', 'yearly'),
        allowNull: false,
        defaultValue: 'monthly',
      },
      status: {
        type: DataTypes.ENUM('active', 'expired', 'cancelled'),
        allowNull: false,
        defaultValue: 'active',
      },
      startDate: { type: DataTypes.DATEONLY, allowNull: false },
      endDate: { type: DataTypes.DATEONLY },
      // Evite de renvoyer plusieurs fois le rappel J-7 si la tache cron
      // tourne plus d'une fois le meme jour (CLAUDE.md - M9).
      reminderSentAt: { type: DataTypes.DATE },
      // Suivi manuel du reglement recu hors plateforme (cash/RIB) par l'admin.
      paymentReference: { type: DataTypes.STRING(100) },
      notes: { type: DataTypes.TEXT },
    },
    {
      tableName: 'subscriptions',
      updatedAt: false,
    }
  );

  Subscription.associate = (models) => {
    Subscription.belongsTo(models.User, { foreignKey: 'userId', as: 'provider' });
    Subscription.hasMany(models.SubscriptionInvoice, { foreignKey: 'subscriptionId', as: 'invoices' });
  };

  return Subscription;
};
