module.exports = (sequelize, DataTypes) => {
  const Invoice = sequelize.define(
    'Invoice',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      clientId: { type: DataTypes.BIGINT.UNSIGNED },
      // Reservation facturee (optionnelle) : permet d'imprimer le detail du
      // sejour (Arrivee/Depart/chambres) sur le PDF, voir pdfService.
      bookingId: { type: DataTypes.BIGINT.UNSIGNED },
      number: { type: DataTypes.STRING(40), allowNull: false },
      // Description libre de la prestation facturee, saisie par le
      // prestataire (ex: "DJ + sonorisation - mariage du 12/09"). Repli sur
      // "Prestation - <titre fiche>" si non renseignee, voir pdfService.
      description: { type: DataTypes.STRING(255) },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      // Taux de TVA en % (ex: 19.00 pour 19%), pas un montant fixe en DT -
      // le montant de TVA est toujours recalcule a l'affichage (amount *
      // taxRate / 100), voir pdfService.generateInvoicePdf.
      taxRate: { type: DataTypes.DECIMAL(5, 2) },
      // Acompte deja verse par le client (declaratif, saisi par le
      // prestataire - aucun paiement en ligne). Le "reste a payer" n'est
      // jamais stocke : toujours recalcule (TTC - acompte), voir
      // utils/invoiceTotals.js.
      deposit: { type: DataTypes.DECIMAL(12, 2) },
      status: {
        type: DataTypes.ENUM('unpaid', 'paid', 'cancelled'),
        allowNull: false,
        defaultValue: 'unpaid',
      },
      pdfUrl: { type: DataTypes.STRING(255) },
      issuedAt: { type: DataTypes.DATEONLY },
    },
    {
      tableName: 'invoices',
      updatedAt: false,
      indexes: [{ unique: true, fields: ['listing_id', 'number'] }],
    }
  );

  Invoice.associate = (models) => {
    Invoice.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
    Invoice.belongsTo(models.Client, { foreignKey: 'clientId', as: 'client' });
    Invoice.belongsTo(models.Booking, { foreignKey: 'bookingId', as: 'booking' });
  };

  return Invoice;
};
