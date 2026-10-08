// Catalogue des plans d'abonnement (Starter/Pro/Premium, CLAUDE.md/MODULES.md
// M9) - persiste en base pour permettre a l'admin (Parametres > Plans &
// Tarifs) de modifier prix/description/limites sans deploiement. La source
// de verite synchrone utilisee partout ailleurs (pdfService, subscription
// controllers...) reste PLAN_CATALOG (planService.js), charge depuis cette
// table au demarrage et mis a jour a chaque modification admin.
module.exports = (sequelize, DataTypes) => {
  const Plan = sequelize.define(
    'Plan',
    {
      key: { type: DataTypes.STRING(20), primaryKey: true },
      label: { type: DataTypes.STRING(60), allowNull: false },
      description: { type: DataTypes.TEXT },
      price: { type: DataTypes.DECIMAL(8, 2), allowNull: false, defaultValue: 0 },
      priceYearly: { type: DataTypes.DECIMAL(8, 2), allowNull: false, defaultValue: 0 },
      // NULL = illimite (ex. Elite), voir planService.updatePlanCatalogEntry.
      maxPhotos: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 5 },
      maxVideos: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 5 },
      maxPromotions: { type: DataTypes.INTEGER, allowNull: true },
      featured: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Fonctionnalite "Mes evenements" (M5, espace prestataire) - activable
      // par plan (ex. desactivee pour Starter), voir providerEventController.
      eventsEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      // Calendrier des disponibilites (espace prestataire) - activable par
      // plan (ex. desactive pour Starter), voir availabilityController.
      calendarEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      // Flotte de vehicules (prestataires Transport uniquement, voir
      // vehicleController) - NULL = illimite, meme convention que maxPhotos.
      maxVehicles: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 2 },
      // Nombre de sous-categories ou la fiche apparait, categorie
      // d'inscription comprise (1 = aucune supplementaire) - NULL = illimite.
      maxCategories: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 1 },
    },
    {
      tableName: 'plans',
    }
  );

  return Plan;
};
