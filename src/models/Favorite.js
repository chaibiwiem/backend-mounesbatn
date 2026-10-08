module.exports = (sequelize, DataTypes) => {
  const Favorite = sequelize.define(
    'Favorite',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    },
    {
      tableName: 'favorites',
      updatedAt: false,
      indexes: [{ unique: true, fields: ['user_id', 'listing_id'] }],
    }
  );

  Favorite.associate = (models) => {
    Favorite.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    Favorite.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
  };

  return Favorite;
};
