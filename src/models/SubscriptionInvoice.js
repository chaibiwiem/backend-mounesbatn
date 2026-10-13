module.exports = (sequelize, DataTypes) => {
  const SubscriptionInvoice = sequelize.define(
    'SubscriptionInvoice',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      subscriptionId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      status: {
        type: DataTypes.ENUM('unpaid', 'paid', 'cancelled'),
        allowNull: false,
        defaultValue: 'unpaid',
      },
      issuedAt: { type: DataTypes.DATEONLY, allowNull: false },
      dueDate: { type: DataTypes.DATEONLY },
      // Periode d'abonnement facturee : copie de subscription.startDate /
      // endDate (jamais saisie a la main). Les factures non payees et celle de la
      // periode en cours (meme payee) suivent les modifications de
      // l'abonnement (plan, dates, prix - voir subscriptionInvoiceController.
      // syncUnpaidInvoicesWithSubscription) ; periodes precedentes et factures
      // annulees restent figees.
      periodStart: { type: DataTypes.DATEONLY },
      periodEnd: { type: DataTypes.DATEONLY },
      pdfUrl: { type: DataTypes.STRING(255) },
    },
    {
      tableName: 'subscription_invoices',
      updatedAt: false,
    }
  );

  SubscriptionInvoice.associate = (models) => {
    SubscriptionInvoice.belongsTo(models.Subscription, {
      foreignKey: 'subscriptionId',
      as: 'subscription',
    });
  };

  return SubscriptionInvoice;
};
