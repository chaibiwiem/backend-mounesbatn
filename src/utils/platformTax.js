const { computeInvoiceTotals } = require('./invoiceTotals');

// Factures emises par Mounesba au prestataire (abonnement M9, frais de mise
// en relation M13) : le montant saisi/calcule est HORS TAXE (prix des plans
// et frais sont des prix HT) ; la TVA tunisienne de 19 % s'ajoute par-dessus.
// Ex. plan Pro 29 DT HT -> TVA 5,51 DT -> 34,51 DT TTC. Meme calcul cote
// frontend : frontend/src/utils/platformTax.js.
const PLATFORM_TAX_RATE = 19;

function computePlatformInvoiceTotals(amountHt) {
  const { ht, taxRate, tva, ttc } = computeInvoiceTotals({ amount: amountHt, taxRate: PLATFORM_TAX_RATE });
  return { ht, taxRate, tva, ttc };
}

module.exports = { PLATFORM_TAX_RATE, computePlatformInvoiceTotals };
