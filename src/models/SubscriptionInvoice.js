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
      // Periode d'abonnement facturee : copie figee de subscription.startDate
      // / endDate au moment de la creation (jamais saisie a la main), pour que
      // la facture affiche toujours les memes dates que l'abonnement facture
      // - meme si l'abonnement est renouvele/modifie ensuite.
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
