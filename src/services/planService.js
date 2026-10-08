const db = require('../models');

const { Subscription } = db;

// Catalogue des plans (CLAUDE.md, MODULES.md M9) : aucun paiement en ligne,
// l'activation/facturation est geree manuellement par l'admin hors plateforme.
// Valeurs par defaut ci-dessous, ecrasees au demarrage par loadPlansFromDb()
// (table `plans`, modifiable depuis Parametres admin > Plans & Tarifs) - ce
// const reste la source de verite SYNCHRONE utilisee par pdfService,
// subscriptionController, etc., qui ne peuvent pas toutes attendre une
// requete DB a chaque lecture.
const PLAN_CATALOG = {
  starter: {
    label: 'Starter',
    description: 'Fiche visible avec les fonctionnalites essentielles - ideal pour demarrer.',
    price: 0,
    priceYearly: 0,
    maxPhotos: 5,
    maxVideos: 3,
    maxPromotions: 1,
    featured: false,
    eventsEnabled: false,
    calendarEnabled: false,
    maxVehicles: 2,
    maxCategories: 1,
  },
  pro: {
    label: 'Pro',
    description: 'Plus de photos et de promotions pour developper votre visibilite.',
    price: 59,
    priceYearly: 59 * 12,
    maxPhotos: 20,
    maxVideos: 5,
    maxPromotions: 5,
    featured: false,
    eventsEnabled: true,
    calendarEnabled: true,
    maxVehicles: 5,
    maxCategories: 3,
  },
  premium: {
    label: 'Premium',
    description: 'Mise en avant prioritaire et promotions illimitees.',
    price: 119,
    priceYearly: 119 * 12,
    maxPhotos: 20,
    maxVideos: 10,
    maxPromotions: Infinity,
    featured: true,
    eventsEnabled: true,
    calendarEnabled: true,
    maxVehicles: 20,
    maxCategories: Infinity,
  },
  elite: {
    label: 'Elite',
    description: 'Toutes les fonctionnalites sans limite - pour les prestataires les plus actifs.',
    price: 69,
    priceYearly: 69 * 12,
    maxPhotos: Infinity,
    maxVideos: Infinity,
    maxPromotions: Infinity,
    featured: true,
    eventsEnabled: true,
    calendarEnabled: true,
    maxVehicles: Infinity,
    maxCategories: Infinity,
  },
};

const VALID_PLANS = Object.keys(PLAN_CATALOG);

// Reflete une ligne `plans` (base) dans le catalogue en memoire - appele au
// demarrage (loadPlansFromDb) et immediatement apres chaque modification
// admin (adminController.updatePlan), pour eviter tout redemarrage serveur.
function updatePlanCatalogEntry(key, row) {
  PLAN_CATALOG[key] = {
    label: row.label,
    description: row.description || '',
    price: Number(row.price),
    priceYearly: Number(row.priceYearly),
    maxPhotos: row.maxPhotos === null ? Infinity : row.maxPhotos,
    maxVideos: row.maxVideos === null ? Infinity : row.maxVideos,
    maxPromotions: row.maxPromotions === null ? Infinity : row.maxPromotions,
    featured: Boolean(row.featured),
    eventsEnabled: Boolean(row.eventsEnabled),
    calendarEnabled: Boolean(row.calendarEnabled),
    maxVehicles: row.maxVehicles === null ? Infinity : row.maxVehicles,
    maxCategories: row.maxCategories === null ? Infinity : row.maxCategories,
  };
}

async function loadPlansFromDb() {
  const { Plan } = db;
  const rows = await Plan.findAll();
  rows.forEach((row) => updatePlanCatalogEntry(row.key, row));
}

// Un abonnement est expire des que sa date de fin est depassee, meme si son
// `status` stocke est encore "active" (aucune tache cron ne le bascule
// automatiquement - seul un rappel email J-7 existe, voir
// subscriptionCronService). Un `status` "expired"/"cancelled" explicite
// compte aussi comme expire, quelle que soit la date.
function isSubscriptionExpired(subscription) {
  if (!subscription) return false;
  if (subscription.status !== 'active') return true;
  if (!subscription.endDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return subscription.endDate < today;
}

// Un prestataire sans ligne subscriptions (compte cree avant ce module, ou
// jamais synchronise) est traite comme Starter par defaut - de meme qu'un
// prestataire dont l'abonnement paye est expire (voir isSubscriptionExpired) :
// le plan reellement applique (`planKey`) retombe sur Starter pour desactiver
// l'usage des fonctionnalites payantes (photos/videos/promotions/evenements/
// mise en avant) tant que l'admin n'a pas renouvele/reactive l'abonnement.
async function getProviderPlan(userId) {
  const subscription = await Subscription.findOne({ where: { userId } });
  const isExpired = isSubscriptionExpired(subscription);
  const planKey = subscription && !isExpired ? subscription.plan : 'starter';
  return { planKey, limits: PLAN_CATALOG[planKey], subscription, isExpired };
}

function addInterval(date, billingCycle) {
  const next = new Date(date);
  if (billingCycle === 'yearly') {
    next.setFullYear(next.getFullYear() + 1);
  } else {
    next.setMonth(next.getMonth() + 1);
  }
  return next.toISOString().slice(0, 10);
}

module.exports = {
  PLAN_CATALOG,
  VALID_PLANS,
  getProviderPlan,
  isSubscriptionExpired,
  addInterval,
  updatePlanCatalogEntry,
  loadPlansFromDb,
};
