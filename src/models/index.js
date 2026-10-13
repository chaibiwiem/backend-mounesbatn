const { Sequelize, DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const db = {};

db.User = require('./User')(sequelize, DataTypes);
db.Category = require('./Category')(sequelize, DataTypes);
db.Listing = require('./Listing')(sequelize, DataTypes);
db.Image = require('./Image')(sequelize, DataTypes);
db.Video = require('./Video')(sequelize, DataTypes);
db.Package = require('./Package')(sequelize, DataTypes);
db.Availability = require('./Availability')(sequelize, DataTypes);
db.Promotion = require('./Promotion')(sequelize, DataTypes);
db.Lead = require('./Lead')(sequelize, DataTypes);
db.Client = require('./Client')(sequelize, DataTypes);
db.Booking = require('./Booking')(sequelize, DataTypes);
db.Review = require('./Review')(sequelize, DataTypes);
db.ReviewPhoto = require('./ReviewPhoto')(sequelize, DataTypes);
db.Contract = require('./Contract')(sequelize, DataTypes);
db.Invoice = require('./Invoice')(sequelize, DataTypes);
db.Subscription = require('./Subscription')(sequelize, DataTypes);
db.SubscriptionInvoice = require('./SubscriptionInvoice')(sequelize, DataTypes);
db.Favorite = require('./Favorite')(sequelize, DataTypes);
db.Dispute = require('./Dispute')(sequelize, DataTypes);
db.Vehicle = require('./Vehicle')(sequelize, DataTypes);
db.VehicleBooking = require('./VehicleBooking')(sequelize, DataTypes);
db.VehicleDecoration = require('./VehicleDecoration')(sequelize, DataTypes);
db.VehicleOption = require('./VehicleOption')(sequelize, DataTypes);
db.LeadOption = require('./LeadOption')(sequelize, DataTypes);
db.ProviderEvent = require('./ProviderEvent')(sequelize, DataTypes);
db.Plan = require('./Plan')(sequelize, DataTypes);
db.PlatformSetting = require('./PlatformSetting')(sequelize, DataTypes);
db.AssociatedService = require('./AssociatedService')(sequelize, DataTypes);
db.City = require('./City')(sequelize, DataTypes);
db.ListingCategory = require('./ListingCategory')(sequelize, DataTypes);
db.CommissionInvoice = require('./CommissionInvoice')(sequelize, DataTypes);
db.Commission = require('./Commission')(sequelize, DataTypes);

Object.values(db).forEach((model) => {
  if (model.associate) model.associate(db);
});

// Champ de formulaire laisse vide ('') sur une colonne non textuelle (nombre,
// date, enum...) : enregistre NULL. Les validateurs (optional({ checkFalsy:
// true })) laissent passer '' ; un MySQL en mode strict (Clever Cloud, prod)
// le refuse alors ("Incorrect integer value: ''" -> erreur 500), la ou un
// MySQL local non strict le convertissait en silence.
const TEXT_TYPES = ['STRING', 'TEXT', 'CHAR', 'CITEXT'];
function blankToNull(model, values) {
  if (!values) return;
  Object.keys(values).forEach((key) => {
    const attribute = model.rawAttributes[key];
    if (values[key] === '' && attribute && !TEXT_TYPES.includes(attribute.type?.key)) {
      values[key] = null;
    }
  });
}
sequelize.addHook('beforeValidate', (instance) => blankToNull(instance.constructor, instance.dataValues));
sequelize.addHook('beforeBulkCreate', (instances) =>
  instances.forEach((instance) => blankToNull(instance.constructor, instance.dataValues))
);
sequelize.addHook('beforeBulkUpdate', (options) => blankToNull(options.model, options.attributes));

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
