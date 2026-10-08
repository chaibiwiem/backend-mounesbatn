const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { UPLOAD_DIR: LISTINGS_UPLOAD_DIR } = require('../middleware/upload');
const { PLAN_CATALOG } = require('./planService');
const { staySummary, roomsSummary } = require('../utils/stay');
const { computeInvoiceTotals } = require('../utils/invoiceTotals');

const ROSE = '#E11D48';
const ROSE_LIGHT = '#FDE4E9';
const INK = '#1F2933';
const GRAY = '#8A9BA8';

function formatDateFr(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function addDays(dateStr, days) {
  const base = dateStr ? new Date(dateStr) : new Date();
  base.setDate(base.getDate() + days);
  return base;
}

const DOCUMENTS_DIR = path.join(__dirname, '../../uploads/documents');
fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

function writePdf(buildFn) {
  return new Promise((resolve, reject) => {
    const filename = `${crypto.randomBytes(16).toString('hex')}.pdf`;
    const filePath = path.join(DOCUMENTS_DIR, filename);
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);
    buildFn(doc);
    doc.end();

    stream.on('finish', () => resolve(`/uploads/documents/${filename}`));
    stream.on('error', reject);
  });
}

// Contrat prestataire -> client (M7) : mise en page lettre formelle (bloc
// prestataire/client en en-tete, date de redaction, objet, corps en
// paragraphes, signature du prestataire) plutot que des sections a puces.
// Memes contraintes que la facture : aucun champ invente (pas de logo/cachet
// numerise, juste une zone vide a signer a la main).
function generateContractPdf(contract, listing, client) {
  return writePdf((doc) => {
    const leftX = doc.page.margins.left;
    const rightX = doc.page.width - doc.page.margins.right;
    const contentWidth = rightX - leftX;
    const halfWidth = contentWidth / 2;

    // --- En-tete : prestataire (expediteur) / client (destinataire) -------
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(INK)
      .text(listing.title, leftX, 55, { width: halfWidth - 10 });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(GRAY)
      .text([listing.address, listing.city, listing.phone ? `Tel : ${listing.phone}` : null].filter(Boolean).join('\n'), leftX, 70, {
        width: halfWidth - 10,
      });

    const clientLines = client
      ? [client.name, client.email, client.phone].filter(Boolean)
      : ['Client non renseigné'];
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(INK)
      .text(clientLines[0], leftX + halfWidth, 55, { width: halfWidth, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(GRAY)
      .text(clientLines.slice(1).join('\n'), leftX + halfWidth, 70, { width: halfWidth, align: 'right' });

    const dateLineY = 130;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text(`Fait à ${listing.city || 'Tunis'}, le ${formatDateFr(new Date())}`, leftX, dateLineY, {
        width: contentWidth,
        align: 'right',
      });

    // --- Titre + objet -----------------------------------------------------
    const titleY = dateLineY + 30;
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text('CONTRAT DE PRESTATION', leftX, titleY);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(GRAY)
      .text(`Référence : CONTRAT-${contract.id}`, leftX, titleY + 22);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(INK)
      .text(`Objet : ${contract.object || 'Non précisé'}`, leftX, titleY + 38, { width: contentWidth });

    // --- Corps (paragraphes) ------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Madame, Monsieur,', leftX, titleY + 66);

    const paymentModeLabel =
      contract.paymentMode === 'cash' ? 'Espèces' : contract.paymentMode === 'rib' ? 'Virement bancaire (RIB)' : null;

    const bodyParagraphs = [
      `Le présent contrat est conclu entre ${listing.title} (« le Prestataire ») et ` +
        `${client ? client.name : 'le Client'} (« le Client »), pour la prestation suivante : ${
          contract.object || 'non précisée'
        }.`,
      `Montant total convenu : ${
        contract.amount != null ? `${Number(contract.amount).toFixed(2)} DT` : 'à définir'
      }${contract.deposit != null ? ` (dont acompte de ${Number(contract.deposit).toFixed(2)} DT)` : ''}.` +
        (paymentModeLabel ? ` Mode de règlement : ${paymentModeLabel}.` : ''),
    ];
    if (contract.terms) {
      bodyParagraphs.push(`Conditions particulières : ${contract.terms}`);
    }
    bodyParagraphs.push(
      'Nous vous remercions de votre confiance et restons à votre disposition pour toute question ' +
        'relative à la présente prestation.'
    );
    bodyParagraphs.push('Veuillez agréer, Madame, Monsieur, l\'expression de nos salutations distinguées.');

    doc.font('Helvetica').fontSize(10).fillColor(INK);
    let cursorY = titleY + 86;
    bodyParagraphs.forEach((paragraph) => {
      doc.text(paragraph, leftX, cursorY, { width: contentWidth, align: 'left' });
      cursorY = doc.y + 12;
    });

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(GRAY)
      .text(
        'Règlement effectué directement entre les parties, hors plateforme Mounesba. ' +
          'Montants indiqués à titre déclaratif — aucun paiement traité par la plateforme.',
        leftX,
        cursorY,
        { width: contentWidth }
      );
    cursorY = doc.y + 20;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`Statut : ${contract.status}`, leftX, cursorY);

    // --- Signature du prestataire (zone vide, a signer/tamponner) --------
    const signatureWidth = 190;
    const signatureHeight = 70;
    const signatureX = rightX - signatureWidth;
    const footerY = doc.page.height - doc.page.margins.bottom - 20;
    // Des conditions particulieres tres longues peuvent repousser le curseur
    // pres du bas de page - nouvelle page plutot que de dessiner la signature
    // hors de la zone visible ou par-dessus le pied de page.
    if (cursorY + 30 + 28 + signatureHeight > footerY - 10) {
      doc.addPage();
      cursorY = doc.page.margins.top;
    }
    const signatureLabelY = cursorY + 30;
    const signatureBoxY = signatureLabelY + 28;

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text(listing.title, signatureX, signatureLabelY, { width: signatureWidth, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(GRAY)
      .text('Signature et cachet du prestataire', signatureX, signatureLabelY + 12, {
        width: signatureWidth,
        align: 'right',
      });
    doc
      .rect(signatureX, signatureBoxY, signatureWidth, signatureHeight)
      .dash(3, { space: 2 })
      .strokeColor(GRAY)
      .lineWidth(0.75)
      .stroke()
      .undash();

    // --- Pied de page --------------------------------------------------
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(GRAY)
      .text(
        'Mounesba met en relation prestataires et clients — le règlement se fait toujours hors ' +
          'plateforme (espèces ou virement), aucun paiement en ligne.',
        leftX,
        doc.page.height - doc.page.margins.bottom - 20,
        { width: contentWidth }
      );
  });
}

// Facture prestataire -> client (M7) : mise en page inspiree d'un modele de
// facture pro (en-tete logo/FACTURE, colonnes Emetteur/Destinataire, tableau
// du detail, bloc totaux, section reglement) plutot que du texte defile brut.
// Aucun champ n'est invente : pas de ligne d'articles multiples (le modele
// Invoice est un montant unique HT/TVA), pas d'IBAN (aucune donnee bancaire
// stockee cote Listing) - uniquement les champs reellement disponibles.
function generateInvoicePdf(invoice, listing, client, booking = null) {
  return writePdf((doc) => {
    const leftX = doc.page.margins.left;
    const rightX = doc.page.width - doc.page.margins.right;
    const contentWidth = rightX - leftX;

    // Bloc decoratif coin haut-droit (accent visuel, pas de contenu).
    doc.rect(doc.page.width - 70, 0, 70, 18).fill(ROSE_LIGHT);
    doc.rect(doc.page.width - 30, 18, 30, 18).fill(INK);

    // --- En-tete : logo (si disponible) + gros titre FACTURE -------------
    let headerBottom = 90;
    if (listing.logoUrl) {
      try {
        const logoPath = path.join(LISTINGS_UPLOAD_DIR, path.basename(listing.logoUrl));
        if (fs.existsSync(logoPath)) {
          doc.image(logoPath, leftX, 45, { width: 50, height: 50 });
        }
      } catch {
        // Logo illisible : on continue sans (jamais bloquant pour la generation).
      }
    }
    // Titre confine a la moitie gauche et FACTURE a la moitie droite (jamais
    // les deux memes coordonnees) : une raison sociale longue ne peut donc
    // jamais chevaucher le gros titre, quelle que soit sa longueur.
    const halfWidth = contentWidth / 2;
    doc
      .font('Times-Bold')
      .fontSize(13)
      .fillColor(INK)
      .text(listing.title, leftX + 60, 55, { width: halfWidth - 60 });

    doc
      .font('Helvetica-Bold')
      .fontSize(28)
      .fillColor(INK)
      .text('FACTURE', leftX + halfWidth, 50, { width: halfWidth, align: 'right', characterSpacing: 1 });

    // --- Date / echeance / numero de facture ------------------------------
    const issuedAt = invoice.issuedAt || new Date().toISOString().slice(0, 10);
    const dueDate = addDays(issuedAt, 30);
    const metaY = headerBottom + 14;

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text(`DATE : ${formatDateFr(issuedAt)}`, leftX, metaY)
      .text(`ÉCHÉANCE : ${formatDateFr(dueDate)}`, leftX, metaY + 13);

    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(`FACTURE N° : ${invoice.number}`, leftX, metaY + 3, { width: contentWidth, align: 'right' });

    const metaBottom = metaY + 34;
    doc.moveTo(leftX, metaBottom).lineTo(rightX, metaBottom).lineWidth(0.75).strokeColor(GRAY).stroke();

    // --- Emetteur / Destinataire ------------------------------------------
    const colWidth = contentWidth / 2 - 10;
    const partiesY = metaBottom + 18;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY).text('ÉMETTEUR :', leftX, partiesY);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY).text('DESTINATAIRE :', rightX - colWidth, partiesY, {
      width: colWidth,
      align: 'right',
    });

    const emitterLines = [listing.title, listing.address, listing.city, listing.phone ? `Tel : ${listing.phone}` : null].filter(
      Boolean
    );
    const recipientLines = client
      ? [client.name, client.email, client.phone].filter(Boolean)
      : ['Client non renseigné'];

    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(emitterLines.join('\n'), leftX, partiesY + 14, {
      width: colWidth,
    });
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(INK)
      .text(recipientLines.join('\n'), rightX - colWidth, partiesY + 14, { width: colWidth, align: 'right' });

    // --- Tableau du detail ---------------------------------------------
    // Le prestataire peut emettre une facture sans TVA (taxRate vide/null) -
    // TVA, TTC et reste a payer ne sont jamais saisis, toujours recalcules
    // (utils/invoiceTotals.js, meme calcul que le formulaire frontend).
    const totals = computeInvoiceTotals(invoice);
    const amount = totals.ht;
    const { taxRate } = totals;
    const taxAmount = totals.tva;
    const total = totals.ttc;

    const tableY = partiesY + 90;
    const col = {
      desc: leftX,
      unit: leftX + contentWidth * 0.45,
      qty: leftX + contentWidth * 0.68,
      total: leftX + contentWidth * 0.82,
    };
    const colWidths = { desc: contentWidth * 0.45, unit: contentWidth * 0.23, qty: contentWidth * 0.14, total: contentWidth * 0.18 };

    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
    doc.text('Description :', col.desc, tableY);
    doc.text('Prix Unitaire :', col.unit, tableY, { width: colWidths.unit, align: 'right' });
    doc.text('Quantité :', col.qty, tableY, { width: colWidths.qty, align: 'right' });
    doc.text('Total :', col.total, tableY, { width: colWidths.total, align: 'right' });

    const headerRuleY = tableY + 16;
    doc.moveTo(leftX, headerRuleY).lineTo(rightX, headerRuleY).lineWidth(1).strokeColor(INK).stroke();

    const rowY = headerRuleY + 12;
    const descriptionText = invoice.description || `Prestation — ${listing.title}`;
    let descHeight = doc.font('Helvetica').fontSize(10).heightOfString(descriptionText, { width: colWidths.desc - 10 });
    doc.text(descriptionText, col.desc, rowY, { width: colWidths.desc - 10 });

    // Detail du sejour facture (reservation "Maison d'hote" liee) : arrivee,
    // depart, nuits, chambres et invites, sous la description.
    if (booking && booking.checkInDate && booking.checkOutDate) {
      const stayDetail = [
        staySummary(booking.checkInDate, booking.checkOutDate),
        roomsSummary(booking.rooms),
        booking.guests ? `Invités : ${booking.guests}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const detailY = rowY + descHeight + 3;
      doc.font('Helvetica').fontSize(8.5).fillColor(GRAY);
      const detailHeight = doc.heightOfString(stayDetail, { width: colWidths.desc - 10 });
      doc.text(stayDetail, col.desc, detailY, { width: colWidths.desc - 10 });
      doc.font('Helvetica').fontSize(10).fillColor(INK);
      descHeight += detailHeight + 3;
    }
    doc.text(`${amount.toFixed(2)} DT`, col.unit, rowY, { width: colWidths.unit, align: 'right' });
    doc.text('1', col.qty, rowY, { width: colWidths.qty, align: 'right' });
    doc.text(`${amount.toFixed(2)} DT`, col.total, rowY, { width: colWidths.total, align: 'right' });

    const rowRuleY = rowY + Math.max(22, descHeight + 8);
    doc.moveTo(leftX, rowRuleY).lineTo(rightX, rowRuleY).lineWidth(0.5).strokeColor(GRAY).stroke();

    // --- Reglement (gauche) + Totaux (droite) -----------------------------
    const totalsY = rowRuleY + 20;
    const totalsLabelWidth = contentWidth * 0.32;
    const totalsValueX = rightX - contentWidth * 0.25;
    const totalsValueWidth = contentWidth * 0.25;

    const totalsRows = [
      ['TOTAL HT :', `${amount.toFixed(2)} DT`],
      [`TVA${taxRate > 0 ? ` ${taxRate}%` : ''} :`, taxRate > 0 ? `${taxAmount.toFixed(2)} DT` : '-'],
      ['REMISE :', '-'],
    ];
    totalsRows.forEach(([label, value], index) => {
      const y = totalsY + index * 15;
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(INK)
        .text(label, totalsValueX - totalsLabelWidth, y, { width: totalsLabelWidth, align: 'right' });
      doc.font('Helvetica').fontSize(9).text(value, totalsValueX, y, { width: totalsValueWidth, align: 'right' });
    });
    const totalTtcY = totalsY + totalsRows.length * 15 + 4;
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(INK)
      .text('TOTAL TTC :', totalsValueX - totalsLabelWidth, totalTtcY, { width: totalsLabelWidth, align: 'right' })
      .text(`${total.toFixed(2)} DT`, totalsValueX, totalTtcY, { width: totalsValueWidth, align: 'right' });

    // Acompte deja verse (declaratif) + reste a payer = TTC - acompte.
    const depositY = totalTtcY + 20;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text('ACOMPTE VERSÉ :', totalsValueX - totalsLabelWidth, depositY, { width: totalsLabelWidth, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .text(totals.deposit > 0 ? `${totals.deposit.toFixed(2)} DT` : '-', totalsValueX, depositY, {
        width: totalsValueWidth,
        align: 'right',
      });
    const remainingY = depositY + 17;
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(ROSE)
      .text('RESTE À PAYER :', totalsValueX - totalsLabelWidth, remainingY, { width: totalsLabelWidth, align: 'right' })
      .text(`${totals.remaining.toFixed(2)} DT`, totalsValueX, remainingY, { width: totalsValueWidth, align: 'right' });
    doc.fillColor(INK);

    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('RÈGLEMENT :', leftX, totalsY, {
      width: contentWidth * 0.5,
    });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(GRAY)
      .text(
        'Réglé directement entre le client et le prestataire (espèces ou virement bancaire), ' +
          'hors plateforme — Mounesba ne traite aucun paiement en ligne.',
        leftX,
        totalsY + 16,
        { width: contentWidth * 0.5 }
      );

    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`Statut : ${invoice.status}`, leftX, totalsY + 60);

    // --- Signature et cachet du prestataire -------------------------------
    // Zone vide destinee a etre signee/tamponnee a la main apres impression -
    // aucune image stockee (pas de fonctionnalite d'upload de cachet).
    const signatureWidth = 190;
    const signatureHeight = 70;
    const signatureX = rightX - signatureWidth;
    const footerY = doc.page.height - doc.page.margins.bottom - 20;
    // Une description de prestation tres longue peut repousser le tableau et
    // les totaux pres du bas de page - nouvelle page plutot que de dessiner
    // la signature hors de la zone visible ou par-dessus le pied de page.
    let signatureLabelY = totalsY + 130;
    if (signatureLabelY + 14 + signatureHeight > footerY - 10) {
      doc.addPage();
      signatureLabelY = doc.page.margins.top;
    }
    const signatureBoxY = signatureLabelY + 14;

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text('Signature et cachet du prestataire :', signatureX, signatureLabelY, {
        width: signatureWidth,
        align: 'right',
      });
    doc
      .rect(signatureX, signatureBoxY, signatureWidth, signatureHeight)
      .dash(3, { space: 2 })
      .strokeColor(GRAY)
      .lineWidth(0.75)
      .stroke()
      .undash();

    // --- Pied de page --------------------------------------------------
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(GRAY)
      .text(
        'Facture émise conformément aux usages tunisiens. Règlement hors plateforme ' +
          '(espèces ou virement) — Mounesba ne traite aucun paiement.',
        leftX,
        doc.page.height - doc.page.margins.bottom - 20,
        { width: contentWidth }
      );
  });
}

// Facture d'abonnement (admin -> prestataire), meme mise en page que
// generateInvoicePdf (prestataire -> client) pour une identite visuelle
// coherente sur toute la plateforme. Montant declaratif, aucun paiement en
// ligne (CLAUDE.md - regle structurante n°1).
function generateSubscriptionInvoicePdf(invoice, subscription, owner) {
  return writePdf((doc) => {
    const leftX = doc.page.margins.left;
    const rightX = doc.page.width - doc.page.margins.right;
    const contentWidth = rightX - leftX;
    const halfWidth = contentWidth / 2;

    // --- En-tete : marque Mounesba (emettrice) / titre du document --------
    doc.font('Times-Bold').fontSize(13).fillColor(INK).text('Mounesba', leftX, 55, { width: halfWidth });
    doc
      .font('Helvetica-Bold')
      .fontSize(28)
      .fillColor(INK)
      .text('FACTURE', leftX + halfWidth, 50, { width: halfWidth, align: 'right', characterSpacing: 1 });

    const headerBottom = 90;

    // --- Date / echeance / numero de facture ------------------------------
    const dueDate = invoice.dueDate || null;
    const metaY = headerBottom + 14;

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text(`DATE : ${formatDateFr(invoice.issuedAt)}`, leftX, metaY)
      .text(`ÉCHÉANCE : ${formatDateFr(dueDate)}`, leftX, metaY + 13);

    // Periode d'abonnement facturee = dates de l'abonnement (copie figee sur
    // la facture, voir models/SubscriptionInvoice.js).
    const periodLabel = invoice.periodStart
      ? `du ${formatDateFr(invoice.periodStart)}${invoice.periodEnd ? ` au ${formatDateFr(invoice.periodEnd)}` : ' (sans date de fin)'}`
      : null;
    if (periodLabel) {
      doc.text(`PÉRIODE : ${periodLabel}`, leftX, metaY + 26);
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(`FACTURE N° : ${invoice.number}`, leftX, metaY + 3, { width: contentWidth, align: 'right' });

    const metaBottom = metaY + (periodLabel ? 46 : 34);
    doc.moveTo(leftX, metaBottom).lineTo(rightX, metaBottom).lineWidth(0.75).strokeColor(GRAY).stroke();

    // --- Emetteur / Destinataire ------------------------------------------
    const colWidth = contentWidth / 2 - 10;
    const partiesY = metaBottom + 18;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY).text('ÉMETTEUR :', leftX, partiesY);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY).text('DESTINATAIRE :', rightX - colWidth, partiesY, {
      width: colWidth,
      align: 'right',
    });

    const emitterLines = ['Mounesba', 'Plateforme de mise en relation évènementielle'];
    const recipientLines = [
      `${owner.firstName} ${owner.lastName}`,
      owner.email,
      owner.phone ? `Tel : ${owner.phone}` : null,
    ].filter(Boolean);

    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(emitterLines.join('\n'), leftX, partiesY + 14, {
      width: colWidth,
    });
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(INK)
      .text(recipientLines.join('\n'), rightX - colWidth, partiesY + 14, { width: colWidth, align: 'right' });

    // --- Tableau du detail ---------------------------------------------
    // Le montant saisi par l'admin (invoice.amount) est le montant TTC facture
    // au prestataire - la TVA (19%, taux standard tunisien) en est deduite
    // pour l'affichage HT/TVA/TTC, jamais ajoutee par-dessus.
    const amountTtc = Number(invoice.amount) || 0;
    const taxRate = 19;
    const amountHt = amountTtc / (1 + taxRate / 100);
    const taxAmount = amountTtc - amountHt;
    const planLabel = PLAN_CATALOG[subscription.plan]?.label || subscription.plan;
    const cycleLabel = subscription.billingCycle === 'yearly' ? 'annuel' : 'mensuel';

    const tableY = partiesY + 90;
    const col = {
      desc: leftX,
      unit: leftX + contentWidth * 0.45,
      qty: leftX + contentWidth * 0.68,
      total: leftX + contentWidth * 0.82,
    };
    const colWidths = { desc: contentWidth * 0.45, unit: contentWidth * 0.23, qty: contentWidth * 0.14, total: contentWidth * 0.18 };

    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
    doc.text('Description :', col.desc, tableY);
    doc.text('Prix Unitaire :', col.unit, tableY, { width: colWidths.unit, align: 'right' });
    doc.text('Quantité :', col.qty, tableY, { width: colWidths.qty, align: 'right' });
    doc.text('Total :', col.total, tableY, { width: colWidths.total, align: 'right' });

    const headerRuleY = tableY + 16;
    doc.moveTo(leftX, headerRuleY).lineTo(rightX, headerRuleY).lineWidth(1).strokeColor(INK).stroke();

    const rowY = headerRuleY + 12;
    const descriptionText = `Abonnement ${planLabel} — ${cycleLabel}`;
    doc.font('Helvetica').fontSize(10).fillColor(INK);
    doc.text(descriptionText, col.desc, rowY, { width: colWidths.desc - 10 });
    if (periodLabel) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(GRAY)
        .text(`Période ${periodLabel}`, col.desc, rowY + 13, { width: colWidths.desc - 10 });
      doc.font('Helvetica').fontSize(10).fillColor(INK);
    }
    doc.text(`${amountHt.toFixed(2)} DT`, col.unit, rowY, { width: colWidths.unit, align: 'right' });
    doc.text('1', col.qty, rowY, { width: colWidths.qty, align: 'right' });
    doc.text(`${amountHt.toFixed(2)} DT`, col.total, rowY, { width: colWidths.total, align: 'right' });

    const rowRuleY = rowY + (periodLabel ? 32 : 22);
    doc.moveTo(leftX, rowRuleY).lineTo(rightX, rowRuleY).lineWidth(0.5).strokeColor(GRAY).stroke();

    // --- Reglement (gauche) + Totaux (droite) -----------------------------
    const totalsY = rowRuleY + 20;
    const totalsLabelWidth = contentWidth * 0.32;
    const totalsValueX = rightX - contentWidth * 0.25;
    const totalsValueWidth = contentWidth * 0.25;

    const totalsRows = [
      ['TOTAL HT :', `${amountHt.toFixed(2)} DT`],
      [`TVA ${taxRate}% :`, `${taxAmount.toFixed(2)} DT`],
      ['REMISE :', '-'],
    ];
    totalsRows.forEach(([label, value], index) => {
      const y = totalsY + index * 15;
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(INK)
        .text(label, totalsValueX - totalsLabelWidth, y, { width: totalsLabelWidth, align: 'right' });
      doc.font('Helvetica').fontSize(9).text(value, totalsValueX, y, { width: totalsValueWidth, align: 'right' });
    });
    const totalTtcY = totalsY + totalsRows.length * 15 + 4;
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(INK)
      .text('TOTAL TTC :', totalsValueX - totalsLabelWidth, totalTtcY, { width: totalsLabelWidth, align: 'right' })
      .text(`${amountTtc.toFixed(2)} DT`, totalsValueX, totalTtcY, { width: totalsValueWidth, align: 'right' });

    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('RÈGLEMENT :', leftX, totalsY, {
      width: contentWidth * 0.5,
    });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(GRAY)
      .text(
        'Réglé directement entre le prestataire et Mounesba (virement bancaire), ' +
          'hors plateforme — aucun paiement en ligne traité.',
        leftX,
        totalsY + 16,
        { width: contentWidth * 0.5 }
      );

    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`Statut : ${invoice.status}`, leftX, totalsY + 60);

    // --- Cachet Mounesba ----------------------------------------------
    const stampWidth = 190;
    const stampHeight = 70;
    const stampX = rightX - stampWidth;
    const stampLabelY = totalsY + 95;
    const stampBoxY = stampLabelY + 14;

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text('Cachet Mounesba :', stampX, stampLabelY, { width: stampWidth, align: 'right' });
    doc
      .rect(stampX, stampBoxY, stampWidth, stampHeight)
      .dash(3, { space: 2 })
      .strokeColor(GRAY)
      .lineWidth(0.75)
      .stroke()
      .undash();

    // --- Pied de page --------------------------------------------------
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(GRAY)
      .text(
        'Facture émise à titre déclaratif. Règlement hors plateforme (espèces ou virement) — ' +
          'Mounesba ne traite aucun paiement en ligne.',
        leftX,
        doc.page.height - doc.page.margins.bottom - 20,
        { width: contentWidth }
      );
  });
}

// Facture mensuelle des frais de mise en relation (Mounesba -> prestataire,
// M13) : une ligne par demande aboutie validee (forfait fixe fige a la
// confirmation). Montants TTC comme la facture d'abonnement (TVA 19% deduite
// pour l'affichage). Reglement hors plateforme - aucun paiement en ligne.
function generateCommissionInvoicePdf(invoice, listing, owner, commissions) {
  return writePdf((doc) => {
    const leftX = doc.page.margins.left;
    const rightX = doc.page.width - doc.page.margins.right;
    const contentWidth = rightX - leftX;
    const halfWidth = contentWidth / 2;
    const bottomLimit = doc.page.height - doc.page.margins.bottom - 60;

    doc.font('Times-Bold').fontSize(13).fillColor(INK).text('Mounesba', leftX, 55, { width: halfWidth });
    doc
      .font('Helvetica-Bold')
      .fontSize(28)
      .fillColor(INK)
      .text('FACTURE', leftX + halfWidth, 50, { width: halfWidth, align: 'right', characterSpacing: 1 });

    const metaY = 104;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text(`DATE : ${formatDateFr(invoice.issuedAt)}`, leftX, metaY)
      .text(`ÉCHÉANCE : ${formatDateFr(invoice.dueDate)}`, leftX, metaY + 13)
      .text(`PÉRIODE : ${invoice.period}`, leftX, metaY + 26);
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(`FACTURE N° : ${invoice.number}`, leftX, metaY + 3, { width: contentWidth, align: 'right' });

    const metaBottom = metaY + 46;
    doc.moveTo(leftX, metaBottom).lineTo(rightX, metaBottom).lineWidth(0.75).strokeColor(GRAY).stroke();

    const colWidth = contentWidth / 2 - 10;
    const partiesY = metaBottom + 18;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY).text('ÉMETTEUR :', leftX, partiesY);
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(GRAY)
      .text('DESTINATAIRE :', rightX - colWidth, partiesY, { width: colWidth, align: 'right' });
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(INK)
      .text('Mounesba\nPlateforme de mise en relation évènementielle', leftX, partiesY + 14, { width: colWidth });
    const recipientLines = [
      listing.title,
      owner ? `${owner.firstName} ${owner.lastName}` : null,
      owner?.email,
      owner?.phone ? `Tel : ${owner.phone}` : null,
    ].filter(Boolean);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(INK)
      .text(recipientLines.join('\n'), rightX - colWidth, partiesY + 14, { width: colWidth, align: 'right' });

    const col = { desc: leftX, date: leftX + contentWidth * 0.62, total: leftX + contentWidth * 0.8 };
    const colWidths = { desc: contentWidth * 0.6, date: contentWidth * 0.18, total: contentWidth * 0.2 };
    let y = partiesY + 100;

    const drawHeader = () => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
      doc.text('Description :', col.desc, y);
      doc.text('Événement :', col.date, y, { width: colWidths.date, align: 'right' });
      doc.text('Montant TTC :', col.total, y, { width: colWidths.total, align: 'right' });
      y += 16;
      doc.moveTo(leftX, y).lineTo(rightX, y).lineWidth(1).strokeColor(INK).stroke();
      y += 10;
    };
    drawHeader();

    commissions.forEach((commission) => {
      if (y > bottomLimit) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
      }
      const clientName = commission.lead ? `${commission.lead.firstName} ${commission.lead.lastName}` : '—';
      doc.font('Helvetica').fontSize(9.5).fillColor(INK);
      // Pourcentage : base de calcul rappelee (taux x montant du contrat declare).
      const basis =
        commission.commissionType === 'percent'
          ? ` (${Number(commission.commissionValue)} % de ${Number(commission.declaredAmount).toFixed(2)} DT)`
          : '';
      const description = `Frais de mise en relation${basis} — demande de ${clientName}`;
      const descOptions = { width: colWidths.desc - 10 };
      doc.text(description, col.desc, y, descOptions);
      doc.text(formatDateFr(commission.eventDate), col.date, y, { width: colWidths.date, align: 'right' });
      doc.text(`${Number(commission.amount).toFixed(2)} DT`, col.total, y, { width: colWidths.total, align: 'right' });
      y += Math.max(20, doc.heightOfString(description, descOptions) + 8);
    });
    doc.moveTo(leftX, y).lineTo(rightX, y).lineWidth(0.5).strokeColor(GRAY).stroke();

    if (y > bottomLimit - 80) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    const amountTtc = Number(invoice.amount) || 0;
    const taxRate = 19;
    const amountHt = amountTtc / (1 + taxRate / 100);
    const totalsY = y + 18;
    const labelWidth = contentWidth * 0.32;
    const valueX = rightX - contentWidth * 0.25;
    const valueWidth = contentWidth * 0.25;
    [
      ['TOTAL HT :', `${amountHt.toFixed(2)} DT`],
      [`TVA ${taxRate}% :`, `${(amountTtc - amountHt).toFixed(2)} DT`],
    ].forEach(([label, value], index) => {
      const rowY = totalsY + index * 15;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(label, valueX - labelWidth, rowY, { width: labelWidth, align: 'right' });
      doc.font('Helvetica').fontSize(9).text(value, valueX, rowY, { width: valueWidth, align: 'right' });
    });
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(INK)
      .text('TOTAL TTC :', valueX - labelWidth, totalsY + 34, { width: labelWidth, align: 'right' })
      .text(`${amountTtc.toFixed(2)} DT`, valueX, totalsY + 34, { width: valueWidth, align: 'right' });

    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('RÈGLEMENT :', leftX, totalsY, { width: contentWidth * 0.5 });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(GRAY)
      .text(
        'Frais de mise en relation pour les demandes reçues via Mounesba, confirmées par le prestataire ' +
          'et validées par Mounesba. Réglés hors plateforme (espèces ou virement) — aucun paiement en ligne.',
        leftX,
        totalsY + 16,
        { width: contentWidth * 0.5 }
      );

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(GRAY)
      .text(
        'Mounesba ne prélève rien sur les montants facturés par le prestataire à ses clients : seuls des frais ' +
          'fixes de mise en relation sont facturés, selon les conditions de référencement acceptées.',
        leftX,
        doc.page.height - doc.page.margins.bottom - 20,
        { width: contentWidth }
      );
  });
}

module.exports = {
  generateContractPdf,
  generateInvoicePdf,
  generateSubscriptionInvoicePdf,
  generateCommissionInvoicePdf,
  DOCUMENTS_DIR,
};
