module.exports = (sequelize, DataTypes) => {
  const Vehicle = sequelize.define(
    'Vehicle',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      type: {
        type: DataTypes.ENUM('voiture', 'bus', 'minibus'),
        allowNull: false,
      },
      brand: { type: DataTypes.STRING(80) },
      model: { type: DataTypes.STRING(80) },
      year: { type: DataTypes.INTEGER },
      seats: { type: DataTypes.INTEGER },
      doors: { type: DataTypes.INTEGER },
      luggage: { type: DataTypes.INTEGER },
      transmission: { type: DataTypes.ENUM('manuelle', 'automatique') },
      pricePerDay: { type: DataTypes.DECIMAL(10, 2) },
      pricePerHour: { type: DataTypes.DECIMAL(10, 2) },
      withDriver: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      airConditioned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Option "voiture décorée" (mariage/fiançailles) : simple indicateur
      // que ce vehicule propose au moins un modele de decoration - les
      // modeles eux-memes (photo/nom/prix) sont geres dans la table
      // vehicle_decorations (VehicleDecoration, association `decorations`),
      // le client en choisit un via un popup dedie (cf. DecorationPickerModal).
      hasDecoration: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Titre affiche au-dessus de la liste d'avantages (description) sur la
      // fiche publique - personnalisable, "Nous vous offrons GRATUITEMENT en
      // plus" par defaut si NULL (voir VehicleFleetSection).
      perksTitle: { type: DataTypes.STRING(255) },
      description: { type: DataTypes.TEXT },
      imageUrl: { type: DataTypes.STRING(255) },
      // Retirer un vehicule de la flotte = soft delete (isAvailable=false),
      // jamais de suppression definitive - meme logique que Listing.deletedAt.
      isAvailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      tableName: 'vehicles',
    }
  );

  Vehicle.associate = (models) => {
    Vehicle.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
    Vehicle.hasMany(models.VehicleBooking, { foreignKey: 'vehicleId', as: 'bookings' });
    Vehicle.hasMany(models.Lead, { foreignKey: 'vehicleId', as: 'leads' });
    Vehicle.hasMany(models.VehicleDecoration, { foreignKey: 'vehicleId', as: 'decorations' });
    Vehicle.hasMany(models.VehicleOption, { foreignKey: 'vehicleId', as: 'options' });
  };

  return Vehicle;
};
