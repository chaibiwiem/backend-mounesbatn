const { fn, col } = require('sequelize');
const db = require('../models');

const { Category, Commission } = db;

// Frais de mise en relation (MODULES.md M13) - regles centralisees.
//
// Version des conditions de referencement acceptees par le prestataire
// (listings.connection_fee_terms_version). A incrementer a chaque
// modification des conditions : les fiches ayant accepte une version
// anterieure gardent la trace de CE qu'elles ont accepte.
const TERMS_VERSION = '2026-10-v1';

// Lignes qui comptent comme "evenement realise via Mounesba" (compteur
// public, classement, taux de conversion) : double confirmation acquise.
const REALIZED_STATUSES = ['validated', 'invoiced', 'paid'];
// Lignes engagees (hors annulees) : totaux prestataire.
const ACTIVE_STATUSES = ['pending_admin', 'validated', 'invoiced', 'paid'];
// Lignes encore modifiables / annulables (jamais une fois facturees).
const OPEN_STATUSES = ['pending_provider', 'pending_admin', 'validated'];

const round2 = (value) => Math.round(Number(value) * 100) / 100;

// Categorie dont le tarif s'applique a une fiche : sa sous-categorie si elle
// est concernee, sinon la categorie principale parente (ex. "Lieux de
// mariage" active d'un coup pour toutes ses sous-categories). null si aucune.
async function resolveFeeCategory(listing) {
  if (!listing?.categoryId) return null;
  const category = await Category.findByPk(listing.categoryId);
  if (!category) return null;
  if (category.commissionEnabled && Number(category.commissionValue) > 0) return category;
  if (category.parentId) {
    const parent = await Category.findByPk(category.parentId);
    if (parent?.commissionEnabled && Number(parent.commissionValue) > 0) return parent;
  }
  return null;
}

// Categorie choisie a la creation d'un prestataire (onboarding admin) :
// meme regle que resolveFeeCategory, a partir d'un simple categoryId.
async function resolveFeeCategoryById(categoryId) {
  return resolveFeeCategory({ categoryId });
}

function hasAcceptedTerms(listing) {
  return Boolean(listing?.connectionFeeTermsAcceptedAt);
}

// Montant des frais, calcule cote serveur uniquement (jamais lu depuis le
// client) a partir d'un tarif { commissionType, commissionValue } (categorie
// ou ligne figee) : forfait fixe en DT, ou pourcentage du montant du contrat
// declare (null si ce montant manque - il est alors obligatoire).
function computeFeeAmount(rate, declaredAmount) {
  if (rate.commissionType === 'percent') {
    if (!(Number(declaredAmount) > 0)) return null;
    return round2((Number(declaredAmount) * Number(rate.commissionValue)) / 100);
  }
  return round2(rate.commissionValue);
}

// Tarif expose au prestataire (avant confirmation) : type + valeur, et
// montant uniquement s'il est connu d'avance (forfait fixe).
function describeRate(category) {
  const commissionType = category.commissionType || 'fixed';
  return {
    categoryName: category.name,
    type: commissionType,
    value: Number(category.commissionValue),
    amount: commissionType === 'fixed' ? round2(category.commissionValue) : null,
  };
}

// Declaration automatique des frais (1re confirmation) quand le prestataire
// confirme lui-meme la demande : reservation enregistree depuis la demande,
// ou demande passee "convertie". Le montant de la reservation sert de montant
// du contrat (base en pourcentage). Ne fait rien - le bouton "Confirmer la
// demande aboutie" reste alors disponible - si : categorie non concernee,
// conditions non acceptees, frais deja declares, demande d'interet sur un
// evenement, ou pourcentage sans montant connu. Ligne 'pending_admin' : la
// validation admin (2e confirmation) reste obligatoire.
async function autoDeclareFee(lead, listing, { eventDate, declaredAmount } = {}) {
  if (!lead || !listing || lead.providerEventId) return null;
  const category = await resolveFeeCategory(listing);
  if (!category || !hasAcceptedTerms(listing)) return null;
  if (await Commission.findOne({ where: { leadId: lead.id } })) return null;
  const amount = computeFeeAmount(category, declaredAmount);
  if (amount === null) return null;
  try {
    return await Commission.create({
      leadId: lead.id,
      listingId: listing.id,
      categoryId: category.id,
      eventDate: eventDate || lead.eventDate || lead.checkInDate || null,
      declaredAmount: Number(declaredAmount) > 0 ? declaredAmount : null,
      commissionType: category.commissionType || 'fixed',
      commissionValue: category.commissionValue,
      amount,
      status: 'pending_admin',
      providerConfirmedAt: new Date(),
    });
  } catch (err) {
    // Deja declaree entre-temps (contrainte UNIQUE sur lead_id).
    if (err.name === 'SequelizeUniqueConstraintError') return null;
    throw err;
  }
}

// Reservation modifiee (montant, date) tant que les frais attendent la
// validation admin : la ligne suit le contrat declare, au tarif FIGE de la
// ligne. Une fois validee/facturee, plus aucune modification.
async function syncPendingFeeWithBooking(booking) {
  if (!booking?.leadId) return null;
  const commission = await Commission.findOne({ where: { leadId: booking.leadId, status: 'pending_admin' } });
  if (!commission) return null;
  if (booking.eventDate) commission.eventDate = booking.eventDate;
  if (Number(booking.totalPrice) > 0) {
    commission.declaredAmount = booking.totalPrice;
    const amount = computeFeeAmount(commission, booking.totalPrice);
    if (amount !== null) commission.amount = amount;
  }
  await commission.save();
  return commission;
}

// Nombre d'evenements realises via Mounesba par fiche (agregation SQL).
async function countRealizedByListing(listingIds) {
  const ids = [...new Set((listingIds || []).map(Number))].filter(Boolean);
  if (ids.length === 0) return new Map();
  const rows = await Commission.findAll({
    where: { listingId: ids, status: REALIZED_STATUSES },
    attributes: ['listingId', [fn('COUNT', col('id')), 'count']],
    group: ['listingId'],
    raw: true,
  });
  return new Map(rows.map((row) => [Number(row.listingId), Number(row.count)]));
}

async function countRealizedEvents(listingId) {
  const counts = await countRealizedByListing([listingId]);
  return counts.get(Number(listingId)) || 0;
}

// Bonus de classement (recherche, tri par defaut) : chaque evenement realise
// via Mounesba ajoute 0,25 au score, plafonne a 2 (8 evenements) pour ne pas
// ecraser la note client. Score = note moyenne (0-5) + bonus.
const RANKING_BONUS_PER_EVENT = 0.25;
const RANKING_BONUS_MAX = 2;
function rankingScore(ratingAvg, realizedCount) {
  return (
    (Number(ratingAvg) || 0) + Math.min(RANKING_BONUS_MAX, (Number(realizedCount) || 0) * RANKING_BONUS_PER_EVENT)
  );
}

// Bornes [debut, fin[ d'un mois "YYYY-MM".
function monthRange(period) {
  const [year, month] = period.split('-').map(Number);
  return { start: new Date(year, month - 1, 1), end: new Date(year, month, 1) };
}

module.exports = {
  TERMS_VERSION,
  REALIZED_STATUSES,
  ACTIVE_STATUSES,
  OPEN_STATUSES,
  resolveFeeCategory,
  resolveFeeCategoryById,
  hasAcceptedTerms,
  computeFeeAmount,
  describeRate,
  autoDeclareFee,
  syncPendingFeeWithBooking,
  countRealizedByListing,
  countRealizedEvents,
  rankingScore,
  monthRange,
  round2,
};
