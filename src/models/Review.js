module.exports = (sequelize, DataTypes) => {
  const Review = sequelize.define(
    'Review',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      // bookingId/userId nullables : un avis peut venir d'une reservation
      // terminee (avis verifie) OU d'un formulaire public sans reservation
      // (visiteur anonyme ou client, avis non verifie) - cf. decision produit.
      bookingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, unique: true },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
      guestName: { type: DataTypes.STRING(100), allowNull: true },
      rating: {
        type: DataTypes.TINYINT.UNSIGNED,
        allowNull: false,
        validate: { min: 1, max: 5 },
      },
      title: { type: DataTypes.STRING(150), allowNull: false },
      recommend: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      qualityRating: {
        type: DataTypes.TINYINT.UNSIGNED,
        allowNull: false,
        validate: { min: 1, max: 5 },
      },
      responseTimeRating: {
        type: DataTypes.TINYINT.UNSIGNED,
        allowNull: false,
        validate: { min: 1, max: 5 },
      },
      professionalismRating: {
        type: DataTypes.TINYINT.UNSIGNED,
        allowNull: false,
        validate: { min: 1, max: 5 },
      },
      valueRating: {
        type: DataTypes.TINYINT.UNSIGNED,
        allowNull: false,
        validate: { min: 1, max: 5 },
      },
      flexibilityRating: {
        type: DataTypes.TINYINT.UNSIGNED,
        allowNull: false,
        validate: { min: 1, max: 5 },
      },
      comment: { type: DataTypes.TEXT },
      providerReply: { type: DataTypes.TEXT },
      isVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      isReported: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    {
      tableName: 'reviews',
      updatedAt: false,
    }
  );

  Review.associate = (models) => {
    Review.belongsTo(models.Booking, { foreignKey: 'bookingId', as: 'booking' });
    Review.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
    Review.belongsTo(models.User, { foreignKey: 'userId', as: 'author' });
    Review.hasMany(models.ReviewPhoto, { foreignKey: 'reviewId', as: 'photos' });
    Review.hasMany(models.Dispute, {
      foreignKey: 'reviewId',
      as: 'disputes',
      onDelete: 'SET NULL',
    });
  };

  return Review;
};
