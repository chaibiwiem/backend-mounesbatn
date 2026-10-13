module.exports = (sequelize, DataTypes) => {
  const ProviderEvent = sequelize.define(
    'ProviderEvent',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      title: { type: DataTypes.STRING(160), allowNull: false },
      description: { type: DataTypes.TEXT },
      type: {
        type: DataTypes.ENUM(
          'portes_ouvertes',
          'show_cooking',
          'defile',
          'lancement',
          'degustation',
          'autre'
        ),
        allowNull: false,
        defaultValue: 'autre',
      },
      eventDate: { type: DataTypes.DATEONLY, allowNull: false },
      startTime: { type: DataTypes.TIME },
      endTime: { type: DataTypes.TIME },
      // Par defaut l'adresse du listing (pre-remplie cote front), modifiable -
      // ex. un show cooking organise dans un lieu different du siège habituel.
      location: { type: DataTypes.STRING(255) },
      imageUrl: { type: DataTypes.STRING(255) },
      isPublished: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    {
      tableName: 'provider_events',
      paranoid: true,
      // deletedAt gere par Sequelize (paranoid) - suppression = soft delete,
      // jamais definitive (coherent avec Listing.deletedAt, CLAUDE.md).
    }
  );

  ProviderEvent.associate = (models) => {
    ProviderEvent.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
    ProviderEvent.hasMany(models.Lead, { foreignKey: 'providerEventId', as: 'interestedLeads' });
  };

  return ProviderEvent;
};
