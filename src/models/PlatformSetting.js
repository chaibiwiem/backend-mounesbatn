// Reglages globaux de la plateforme (Parametres admin) - un seul enregistrement
// (singleton), toujours accede via findOne()/findOrCreate(), jamais par id
// explicite. Pour l'instant : SMTP/Resend systeme (verification de compte,
// reinitialisation de mot de passe, notifications) - meme forme que
// listing.emailSettings (secrets chiffres, cf. utils/secretCipher), mais en
// colonnes explicites plutot qu'un JSON, pour rester coherent avec le reste
// du schema.
module.exports = (sequelize, DataTypes) => {
  const PlatformSetting = sequelize.define(
    'PlatformSetting',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      emailProvider: { type: DataTypes.ENUM('smtp', 'resend'), allowNull: true },
      emailHost: { type: DataTypes.STRING(160) },
      emailPort: { type: DataTypes.STRING(10) },
      emailUser: { type: DataTypes.STRING(160) },
      emailFromEmail: { type: DataTypes.STRING(160) },
      emailPassEncrypted: { type: DataTypes.TEXT },
      emailApiKeyEncrypted: { type: DataTypes.TEXT },
    },
    {
      tableName: 'platform_settings',
    }
  );

  return PlatformSetting;
};
