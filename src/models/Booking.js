const { jsonColumnGetter } = require('../utils/stay');

module.exports = (sequelize, DataTypes) => {
  const Booking = sequelize.define(
    'Booking',
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      leadId: { type: DataTypes.BIGINT.UNSIGNED },
      listingId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      clientId: { type: DataTypes.BIGINT.UNSIGNED },
      userId: { type: DataTypes.BIGINT.UNSIGNED },
      eventDate: { type: DataTypes.DATEONLY },
      // Heure de debut/fin optionnelle de la prestation (calendrier M5, vues
      // Semaine/Jour) - eventDate seul suffisait pour la vue Mois existante,
      // mais un positionnement horaire reel necessite ces deux champs.
      startTime: { type: DataTypes.TIME },
      endTime: { type: DataTypes.TIME },
      status: {
        type: DataTypes.ENUM('pending', 'confirmed', 'completed', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending',
      },
      totalPrice: { type: DataTypes.DECIMAL(12, 2) },
      deposit: { type: DataTypes.DECIMAL(12, 2) },
      paymentMethod: { type: DataTypes.ENUM('cash', 'rib') },
      notes: { type: DataTypes.TEXT },
      // Sejour "Maison d'hote" (meme champs que la demande, Lead) : stockes sur
      // la reservation elle-meme, comme VehicleBooking pour ses dates - pre-remplis
      // depuis la demande mais modifiables, et presents aussi pour une
      // reservation saisie sans demande. eventDate = checkInDate dans ce cas.
      checkInDate: { type: DataTypes.DATEONLY },
      checkOutDate: { type: DataTypes.DATEONLY },
      rooms: { type: DataTypes.JSON, get: jsonColumnGetter('rooms') },
      guests: { type: DataTypes.STRING(40) },
      // Pack choisi (catalogue du prestataire), repris de la demande ou
      // saisi par le prestataire - NULL si aucun pack precis.
      packageId: { type: DataTypes.BIGINT.UNSIGNED },
      // Prix de la prestation (hors chambres et pack) saisi par le prestataire,
      // et remise (montant en DT ou pourcentage) deduite du total calcule
      // (chambres x nuits + prestation + pack) - toutes categories, voir
      // computeBookingTotal.
      servicePrice: { type: DataTypes.DECIMAL(10, 2) },
      discountType: { type: DataTypes.ENUM('amount', 'percent') },
      discountValue: { type: DataTypes.DECIMAL(10, 2) },
    },
    {
      tableName: 'bookings',
    }
  );

  Booking.associate = (models) => {
    Booking.belongsTo(models.Lead, { foreignKey: 'leadId', as: 'lead' });
    Booking.belongsTo(models.Listing, { foreignKey: 'listingId', as: 'listing' });
    Booking.belongsTo(models.Client, { foreignKey: 'clientId', as: 'client' });
    Booking.belongsTo(models.Package, { foreignKey: 'packageId', as: 'package' });
    Booking.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    Booking.hasOne(models.Review, { foreignKey: 'bookingId', as: 'review' });
  };

  return Booking;
};
