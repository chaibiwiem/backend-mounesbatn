// Calcul unique des totaux d'une facture prestataire -> client, utilise par
// le controller (validation de l'acompte) et le PDF. Rien n'est stocke a part
// les saisies du prestataire (montant HT, taux de TVA, acompte) : TVA, TTC et
// reste a payer sont toujours recalcules. Meme logique cote frontend :
// frontend/src/utils/invoiceTotals.js.
const round2 = (value) => Math.round(value * 100) / 100;

function computeInvoiceTotals({ amount, taxRate, deposit }) {
  const ht = Number(amount) || 0;
  const rate = Number(taxRate) || 0;
  const tva = round2((ht * rate) / 100);
  const ttc = round2(ht + tva);
  const paid = Number(deposit) || 0;
  const remaining = round2(Math.max(ttc - paid, 0));
  return { ht: round2(ht), taxRate: rate, tva, ttc, deposit: round2(paid), remaining };
}

module.exports = { computeInvoiceTotals };
