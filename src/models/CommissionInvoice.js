// Facture mensuelle des frais de mise en relation (Mounesba -> prestataire),
// regroupant les lignes `commissions` validees d'une fiche. Distincte de
// `invoices` (factures du prestataire a SES clients, M7) et de
// `subscription_invoices` (abonnement, M9). Reglement hors plateforme
// (especes ou virement) - aucun paiement en ligne (CLAUDE.md, regle n°1).
module.exports = (sequelize, DataTypes) => {
  const CommissionInvoice = sequelize.define(
    'CommissionInvoice',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      // Mois facture, format YYYY-MM.
      period: { type: DataTypes.STRING(7), allowNull: false },
      amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      status: {
        type: DataTypes.ENUM('unpaid', 'paid', 'cancelled'),
        allowNull: false,
        defaultValue: 'unpaid',
      },
      issuedAt: { type: DataTypes.DATEONLY, allowNull: false },
      dueDate: { type: DataTypes.DATEONLY },
      paidAt: { type: DataTypes.DATE },
      pdfUrl: { type: DataTypes.STRING(255) },
    },
    {
      tableName: 'commission_invoices',
    }
  );

  CommissionInvoice.associate = (models) => {
    CommissionInvoice.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
    CommissionInvoice.hasMany(models.Commission, { foreignKey: 'invoiceId', as: 'commissions' });
  };

  return CommissionInvoice;
};
