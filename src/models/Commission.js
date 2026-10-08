// Frais de mise en relation (MODULES.md M13) : une ligne par demande de devis
// aboutie dans une categorie concernee (categories.commission_enabled).
// Forfait fixe (DT) ou pourcentage du montant du contrat declare par le
// prestataire (CLAUDE.md, regle structurante n°3). Le tarif est COPIE
// ici a la creation (commission_type / commission_value) : une modification
// ulterieure de la categorie ne change jamais des frais deja engages.
// Aucun paiement en ligne : facture reglee hors plateforme (CommissionInvoice).
const COMMISSION_STATUSES = ['pending_provider', 'pending_admin', 'validated', 'invoiced', 'paid', 'cancelled'];

module.exports = (sequelize, DataTypes) => {
  const Commission = sequelize.define(
    'Commission',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      // UNIQUE : une demande ne genere jamais plus d'un frais (anti double facturation).
      leadId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: true },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      categoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      // Date de l'evenement declaree par le prestataire a la confirmation.
      eventDate: { type: DataTypes.DATEONLY },
      // Montant du contrat declare : base de calcul en pourcentage (alors
      // obligatoire), simplement informatif au forfait fixe.
      declaredAmount: { type: DataTypes.DECIMAL(10, 2) },
      commissionType: { type: DataTypes.ENUM('fixed', 'percent'), allowNull: false, defaultValue: 'fixed' },
      commissionValue: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      status: {
        type: DataTypes.ENUM(...COMMISSION_STATUSES),
        allowNull: false,
        defaultValue: 'pending_provider',
      },
      providerConfirmedAt: { type: DataTypes.DATE },
      adminValidatedAt: { type: DataTypes.DATE },
      adminUserId: { type: DataTypes.BIGINT.UNSIGNED },
      cancelReason: { type: DataTypes.STRING(255) },
      // Contestation par le prestataire d'une ligne validee non facturee.
      disputeComment: { type: DataTypes.STRING(500) },
      disputedAt: { type: DataTypes.DATE },
      invoiceId: { type: DataTypes.BIGINT.UNSIGNED },
      // Invitation du client a laisser un avis verifie (envoyee une fois,
      // apres validation admin et une fois la date de l'evenement passee).
      reviewInviteSentAt: { type: DataTypes.DATE },
    },
    {
      tableName: 'commissions',
    }
  );

  Commission.associate = (models) => {
    Commission.belongsTo(models.Lead, { foreignKey: 'leadId', as: 'lead' });
    Commission.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
    Commission.belongsTo(models.Category, { foreignKey: 'categoryId', as: 'category' });
    Commission.belongsTo(models.User, { foreignKey: 'adminUserId', as: 'validatedBy' });
    Commission.belongsTo(models.CommissionInvoice, { foreignKey: 'invoiceId', as: 'invoice' });
  };

  Commission.STATUSES = COMMISSION_STATUSES;
  return Commission;
};
