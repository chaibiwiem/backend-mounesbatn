module.exports = (sequelize, DataTypes) => {
  const Video = sequelize.define(
    'Video',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      // 'link' : lien externe YouTube/Vimeo (embedUrl = iframe src derivee).
      // 'upload' : fichier MP4/WebM heberge sur le serveur (url = chemin
      // /uploads/videos/..., embedUrl null, lu via <video> natif).
      type: {
        type: DataTypes.ENUM('link', 'upload'),
        allowNull: false,
        defaultValue: 'link',
      },
      url: { type: DataTypes.STRING(500), allowNull: false },
      embedUrl: { type: DataTypes.STRING(500) },
      // Vignette pour l'affichage en grille (bouton play en overlay) : derivee
      // automatiquement pour YouTube, absente pour Vimeo/upload (pas d'appel
      // API externe ni d'extraction de frame video cote serveur).
      thumbnailUrl: { type: DataTypes.STRING(500) },
      title: { type: DataTypes.STRING(160) },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'videos',
      updatedAt: false,
    }
  );

  Video.associate = (models) => {
    Video.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
  };

  return Video;
};
