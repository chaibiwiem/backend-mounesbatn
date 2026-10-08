module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'User',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      role: {
        type: DataTypes.ENUM('client', 'provider', 'admin'),
        allowNull: false,
        defaultValue: 'client',
      },
      // Sous-role reserve aux comptes role='admin' (CLAUDE.md / MODULES.md M10) :
      // determine les actions de gestion des prestataires autorisees.
      adminRole: {
        type: DataTypes.ENUM('super_admin', 'moderator', 'support', 'analyst'),
        allowNull: true,
      },
      firstName: { type: DataTypes.STRING(80), allowNull: false },
      lastName: { type: DataTypes.STRING(80), allowNull: false },
      // Reserve aux comptes role='client' : role du client dans son propre
      // evenement (marie(e)/autre organisateur), saisi a l'inscription,
      // optionnel et non utilise pour la logique metier - purement informatif.
      weddingRole: { type: DataTypes.ENUM('bride', 'groom', 'other'), allowNull: true },
      email: { type: DataTypes.STRING(160), allowNull: false, unique: true },
      phone: { type: DataTypes.STRING(20), unique: true },
      passwordHash: { type: DataTypes.STRING(255), allowNull: false },
      avatarUrl: { type: DataTypes.STRING(255) },
      emailVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      emailVerifyToken: { type: DataTypes.STRING(100) },
      resetToken: { type: DataTypes.STRING(100) },
      resetTokenExpires: { type: DataTypes.DATE },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      lastLoginAt: { type: DataTypes.DATE },
    },
    {
      tableName: 'users',
    }
  );

  User.associate = (models) => {
    User.hasMany(models.Listing, { foreignKey: 'userId', as: 'listings' });
    User.hasMany(models.Lead, { foreignKey: 'userId', as: 'leads' });
    User.hasMany(models.Client, { foreignKey: 'userId', as: 'clientProfiles' });
    User.hasMany(models.Booking, { foreignKey: 'userId', as: 'bookings' });
    User.hasMany(models.Review, { foreignKey: 'userId', as: 'reviews' });
    User.hasMany(models.Subscription, { foreignKey: 'userId', as: 'subscriptions' });
    User.hasMany(models.Favorite, { foreignKey: 'userId', as: 'favorites' });
    User.hasMany(models.Dispute, { foreignKey: 'reporterId', as: 'reportedDisputes' });
  };

  return User;
};
