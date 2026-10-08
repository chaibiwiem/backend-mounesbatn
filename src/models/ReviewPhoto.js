module.exports = (sequelize, DataTypes) => {
  const ReviewPhoto = sequelize.define(
    'ReviewPhoto',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      reviewId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      url: { type: DataTypes.STRING(255), allowNull: false },
    },
    {
      tableName: 'review_photos',
      timestamps: false,
    }
  );

  ReviewPhoto.associate = (models) => {
    ReviewPhoto.belongsTo(models.Review, { foreignKey: 'reviewId', as: 'review' });
  };

  return ReviewPhoto;
};
