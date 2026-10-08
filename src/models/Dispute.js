module.exports = (sequelize, DataTypes) => {
  const Dispute = sequelize.define(
    'Dispute',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      reporterId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      listingId: { type: DataTypes.BIGINT.UNSIGNED },
      reviewId: { type: DataTypes.BIGINT.UNSIGNED },
      type: {
        type: DataTypes.ENUM('no_show', 'misleading', 'fake_review', 'other'),
        allowNull: false,
        defaultValue: 'other',
      },
      description: { type: DataTypes.TEXT },
      status: {
        type: DataTypes.ENUM('open', 'in_review', 'resolved', 'rejected'),
        allowNull: false,
        defaultValue: 'open',
      },
      resolution: { type: DataTypes.TEXT },
      resolvedAt: { type: DataTypes.DATE },
    },
    {
      tableName: 'disputes',
      updatedAt: false,
    }
  );

  Dispute.associate = (models) => {
    Dispute.belongsTo(models.User, {
      foreignKey: 'reporterId',
      as: 'reporter',
      onDelete: 'CASCADE',
    });
    // Le litige survit à la suppression de la fiche/de l'avis d'origine
    // (schéma : ON DELETE SET NULL) pour garder une trace de modération.
    Dispute.belongsTo(models.Listing, {
      foreignKey: 'listingId',
      as: 'listing',
      onDelete: 'SET NULL',
    });
    Dispute.belongsTo(models.Review, {
      foreignKey: 'reviewId',
      as: 'review',
      onDelete: 'SET NULL',
    });
  };

  return Dispute;
};
