const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { decrypt } = require('../utils/secretCipher');
const { computeInvoiceTotals } = require('../utils/invoiceTotals');

// Meme dossier que pdfService.DOCUMENTS_DIR (contrats/factures PDF generes).
const DOCUMENTS_DIR = path.join(__dirname, '../../uploads/documents');

const platformTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
});

// Configuration SMTP/Resend systeme, modifiable depuis Parametres admin >
// Email SMTP (platformSettingsController) - mise en cache pour ne pas
// requeter la base a chaque email envoye, invalidee explicitement a chaque
// sauvegarde admin (clearPlatformSettingsCache). Tant qu'aucune config n'est
// enregistree, `platformTransporter` (process.env.SMTP_*) reste utilise -
// comportement inchange, cf. sendMail.
let platformSettingsCache;
async function getPlatformSettings() {
  if (platformSettingsCache === undefined) {
    const db = require('../models');
    platformSettingsCache = await db.PlatformSetting.findOne();
  }
  return platformSettingsCache;
}

function clearPlatformSettingsCache() {
  platformSettingsCache = undefined;
}

// Envoie via l'API Resend (pas de dependance supplementaire : appel HTTP
// direct avec le fetch natif de Node 18+).
async function sendViaResend(apiKey, { from, to, subject, html, text, attachments }) {
  // Resend attend le contenu des pieces jointes en base64.
  const resendAttachments = attachments?.length
    ? attachments.map((a) => ({ filename: a.filename, content: fs.readFileSync(a.path).toString('base64') }))
    : undefined;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html, text, attachments: resendAttachments }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend a répondu ${res.status} : ${body}`);
  }
}

// Alternative texte brut generee automatiquement a partir du HTML : un email
// transactionnel HTML-only (sans partie text/plain) est un signal classique
// de spam pour les filtres (Gmail en particulier) - toutes les fonctions
// d'envoi ci-dessous restent single-source (un seul argument `html` a
// ecrire), cette fonction derive la version texte sans dupliquer chaque
// template.
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Lien de connexion pre-rempli (identifiants envoyes au prestataire -
// creation de compte / reinitialisation de mot de passe) : email en query
// param (lu par Login.jsx via useSearchParams), mot de passe temporaire dans
// le fragment (#password=...) plutot qu'en query param - le fragment n'est
// jamais envoye au serveur ni present dans les logs d'acces/CSP reports,
// limite l'exposition du mot de passe en clair au strict necessaire (il
// reste neanmoins visible dans l'historique du navigateur, comme tout lien
// clique - c'est un compromis assume pour eviter une erreur de transcription
// manuelle, le mot de passe est de toute facon deja en clair dans l'email).
function buildLoginLink(email, temporaryPassword) {
  const base = `${process.env.FRONTEND_URL}/login?email=${encodeURIComponent(email)}`;
  return temporaryPassword ? `${base}#password=${encodeURIComponent(temporaryPassword)}` : base;
}

// "From" avec nom affiche ("Mounesba" plutot que l'adresse brute) : autre
// signal de legitimite pour les filtres anti-spam, et plus lisible pour le
// destinataire. N'ecrase jamais un "From" deja au format `Nom <email>`.
function withDisplayName(fromEmail, name = 'Mounesba') {
  if (!fromEmail) return fromEmail;
  if (/<.+>/.test(fromEmail)) return fromEmail;
  const safeName = String(name).replace(/["\r\n]/g, '').trim() || 'Mounesba';
  return `"${safeName}" <${fromEmail}>`;
}

// Piece jointe PDF d'un document genere (facture/contrat) a partir de son
// pdfUrl (/uploads/documents/<fichier>.pdf). Joindre le PDF plutot qu'envoyer
// un lien nu vers un fichier : un email "telechargez votre facture ici" +
// lien vers un .pdf au nom aleatoire est le modele type des emails de
// phishing, que Gmail classe en spam ; et un lien vers localhost en dev n'est
// de toute facon pas accessible au destinataire. null si fichier absent.
function documentAttachment(pdfUrl, filename) {
  if (!pdfUrl) return null;
  const filePath = path.join(DOCUMENTS_DIR, path.basename(pdfUrl));
  if (!fs.existsSync(filePath)) return null;
  return { filename, path: filePath, contentType: 'application/pdf' };
}

const formatDateFr = (value) =>
  value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('fr-FR') : '';

// N'interrompt jamais le flux appelant (sauf sendTestEmail, qui a besoin de
// remonter l'erreur pour informer le prestataire) : un echec d'envoi est
// logge, pas leve, pour ne pas faire echouer une action deja enregistree
// en base (inscription, creation de facture...).
//
// `listing` optionnel : si fourni et que sa config email_settings (M5,
// "Email SMTP") est complete, l'email part depuis l'identite du prestataire
// (son propre SMTP ou Resend) plutot que du SMTP central de la plateforme -
// pertinent uniquement pour les emails prestataire -> client (facture,
// contrat). Sans configuration ou pour les emails plateforme -> utilisateur
// (verification, notifications...), comportement inchange.
async function sendMail(to, subject, html, { listing, throwOnError = false, attachments } = {}) {
  const settings = listing?.emailSettings;
  const text = htmlToText(html);
  const files = (attachments || []).filter(Boolean);

  try {
    // Envoi depuis l'identite du prestataire : nom affiche = nom de sa fiche
    // (ex. "Pascal Tesson" <son-adresse>) plutot que l'adresse brute.
    if (settings?.provider === 'resend' && settings.apiKeyEncrypted) {
      const apiKey = decrypt(settings.apiKeyEncrypted);
      await sendViaResend(apiKey, {
        from: withDisplayName(settings.fromEmail || settings.user || 'contact@mounesba.tn', listing.title),
        to,
        subject,
        html,
        text,
        attachments: files,
      });
      return;
    }

    if (settings?.provider === 'smtp' && settings.host && settings.user && settings.passEncrypted) {
      const providerTransporter = nodemailer.createTransport({
        host: settings.host,
        port: Number(settings.port) || 587,
        secure: Number(settings.port) === 465,
        auth: { user: settings.user, pass: decrypt(settings.passEncrypted) },
      });
      await providerTransporter.sendMail({
        from: withDisplayName(settings.fromEmail || settings.user, listing.title),
        to,
        subject,
        html,
        text,
        attachments: files,
      });
      return;
    }

    // Config plateforme (Parametres admin > Email SMTP) : utilisee pour tous
    // les emails systeme (verification, reset...) et par defaut pour les
    // emails prestataire sans configuration propre. "From" avec nom affiche +
    // partie texte brut (htmlToText) : signaux de legitimite pour les filtres
    // anti-spam (Gmail en particulier flague les emails HTML-only envoyes
    // sans nom d'expediteur depuis un compte Gmail personnel) - voir
    // CLAUDE.md, section Emails.
    const platformSettings = await getPlatformSettings();

    if (platformSettings?.emailProvider === 'resend' && platformSettings.emailApiKeyEncrypted) {
      const apiKey = decrypt(platformSettings.emailApiKeyEncrypted);
      await sendViaResend(apiKey, {
        from: withDisplayName(platformSettings.emailFromEmail || 'contact@mounesba.tn'),
        to,
        subject,
        html,
        text,
        attachments: files,
      });
      return;
    }

    if (
      platformSettings?.emailProvider === 'smtp' &&
      platformSettings.emailHost &&
      platformSettings.emailUser &&
      platformSettings.emailPassEncrypted
    ) {
      const platformDbTransporter = nodemailer.createTransport({
        host: platformSettings.emailHost,
        port: Number(platformSettings.emailPort) || 587,
        secure: Number(platformSettings.emailPort) === 465,
        auth: { user: platformSettings.emailUser, pass: decrypt(platformSettings.emailPassEncrypted) },
      });
      await platformDbTransporter.sendMail({
        from: withDisplayName(platformSettings.emailFromEmail || platformSettings.emailUser),
        to,
        subject,
        html,
        text,
        attachments: files,
      });
      return;
    }

    await platformTransporter.sendMail({
      from: withDisplayName(process.env.SMTP_USER || 'contact@mounesba.tn'),
      to,
      subject,
      html,
      text,
      attachments: files,
    });
  } catch (err) {
    console.error(`Échec envoi email à ${to} :`, err.message);
    if (throwOnError) throw err;
  }
}

// Email de test envoye depuis l'onglet "Email SMTP" du dashboard prestataire,
// pour verifier une configuration avant de compter dessus pour les
// factures/contrats. Remonte l'erreur (throwOnError) : contrairement aux
// autres emails, l'utilisateur doit savoir immediatement si ca a echoue.
async function sendTestEmail(listing, toEmail) {
  await sendMail(
    toEmail,
    'Email de test - Mounesba',
    `<p>Ceci est un email de test envoyé depuis la configuration email de
     <strong>${escapeHtml(listing.title)}</strong> sur Mounesba.</p>
     <p>Si vous recevez ce message, votre configuration fonctionne correctement.</p>`,
    { listing, throwOnError: true }
  );
}

// Email de test envoye depuis Parametres admin > Email SMTP - passe par le
// chemin normal de sendMail (sans `listing`), donc teste exactement la
// configuration active pour tous les emails systeme.
async function sendPlatformTestEmail(toEmail) {
  await sendMail(
    toEmail,
    'Email de test - Mounesba (plateforme)',
    `<p>Ceci est un email de test envoyé depuis la configuration email de la plateforme Mounesba.</p>
     <p>Si vous recevez ce message, votre configuration fonctionne correctement.</p>`,
    { throwOnError: true }
  );
}

async function sendVerificationEmail(user, token) {
  const link = `${process.env.FRONTEND_URL}/verify-email/${token}`;
  await sendMail(
    user.email,
    'Confirmez votre email Mounesba',
    `<p>Bonjour ${escapeHtml(user.firstName)},</p>
     <p>Merci de confirmer votre email en cliquant sur le lien ci-dessous :</p>
     <p><a href="${link}">${link}</a></p>`
  );
}

async function sendPasswordResetEmail(user, token) {
  const link = `${process.env.FRONTEND_URL}/reset-password/${token}`;
  await sendMail(
    user.email,
    'Réinitialisation de votre mot de passe Mounesba',
    `<p>Bonjour ${escapeHtml(user.firstName)},</p>
     <p>Vous avez demandé la réinitialisation de votre mot de passe. Ce lien expire dans 1 heure :</p>
     <p><a href="${link}">${link}</a></p>
     <p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>`
  );
}

// Demande de location de vehicule (prestataire Transport, cf.
// leadController) : departureDatetime n'est renseigne que dans ce cas, donc
// sert de marqueur pour choisir le bon jeu de details a afficher au
// prestataire (dates/passagers/chauffeur plutot que date d'evenement/invites).
async function sendNewLeadEmail(providerUser, lead, listing) {
  const isTransportLead = Boolean(lead.departureDatetime);
  // Marqueur leger (meme principe que isTransportLead) : les champs produit
  // ne sont renseignes que pour les prestataires "Parfums & Soins", voir
  // leadController.createLead.
  const isProductLead = Boolean(lead.quantity || lead.deliveryDate || lead.deliveryMode);
  // Meme principe : checkInDate n'est renseigne que pour les prestataires
  // "Maison d'hote" (sejour en chambres), voir leadController.createLead.
  const isAccommodationLead = Boolean(lead.checkInDate);

  // Demande d'interet sur un evenement prestataire (M5) : le contexte est
  // deja donne par eventLine, pas besoin de repeter date/invites (non
  // renseignes pour ce type de demande, cf. leadController.createLead).
  const detailItems = lead.interestedEvent
    ? []
    : isTransportLead
    ? [
        `Départ : ${new Date(lead.departureDatetime).toLocaleString('fr-FR')}`,
        lead.returnDatetime
          ? `Retour : ${new Date(lead.returnDatetime).toLocaleString('fr-FR')}`
          : null,
        lead.passengers ? `Passagers : ${lead.passengers}` : null,
        lead.withDriver === true ? 'Avec chauffeur' : lead.withDriver === false ? 'Sans chauffeur' : null,
        lead.decoration ? `Décoration : ${lead.decoration.name}` : null,
        lead.selectedOptions?.length > 0
          ? `Options : ${lead.selectedOptions.map((s) => `${s.option?.name} x${s.quantity}`).join(', ')}`
          : null,
        lead.pickupLocation ? `Lieu de prise en charge : ${lead.pickupLocation}` : null,
      ]
    : isProductLead
    ? [
        lead.package ? `Produit souhaité : ${lead.package.name}` : null,
        lead.quantity ? `Quantité : ${lead.quantity}` : null,
        lead.deliveryDate ? `Date de livraison souhaitée : ${lead.deliveryDate}` : null,
        lead.deliveryMode === 'livraison'
          ? 'Mode : Livraison'
          : lead.deliveryMode === 'retrait'
          ? 'Mode : Retrait'
          : null,
        lead.deliveryMode === 'livraison' && lead.deliveryAddress
          ? `Adresse de livraison : ${lead.deliveryAddress}`
          : null,
        lead.customization ? `Personnalisation : ${lead.customization}` : null,
      ]
    : isAccommodationLead
    ? [
        `Arrivée : ${lead.checkInDate}`,
        lead.checkOutDate ? `Départ : ${lead.checkOutDate}` : null,
        ...(Array.isArray(lead.rooms)
          ? lead.rooms.map(
              (room, index) =>
                `Chambre ${index + 1} : ${room.adults} adulte(s), ${room.children || 0} enfant(s), ${
                  room.babies || 0
                } lit(s) bébé`
            )
          : []),
        lead.guests ? `Nombre d'invités : ${lead.guests}` : null,
      ]
    : [
        `Date de l'événement : ${lead.eventDate || 'Non précisée'} ${lead.dateFlexible ? '(flexible)' : ''}`,
        `Nombre d'invités : ${lead.guests || 'Non précisé'}`,
      ];
  // Pack coche sur la fiche (toutes categories ; deja affiche pour un produit).
  if (!isProductLead && lead.package) {
    detailItems.push(
      `Pack souhaité : ${lead.package.name}${Number(lead.package.price) > 0 ? ` (${lead.package.price} DT)` : ''}`
    );
  }

  const eventLine = lead.interestedEvent
    ? `<p>Intéressé(e) par votre événement : <strong>${escapeHtml(lead.interestedEvent.title)}</strong></p>`
    : '';

  await sendMail(
    providerUser.email,
    lead.interestedEvent
      ? `Nouvelle demande d'intérêt - ${listing.title}`
      : `Nouvelle demande de devis - ${listing.title}`,
    `<p>Bonjour ${escapeHtml(providerUser.firstName)},</p>
     <p>Vous avez reçu une nouvelle demande pour <strong>${escapeHtml(listing.title)}</strong> :</p>
     ${eventLine}
     <ul>
       <li>Nom : ${escapeHtml(lead.firstName)} ${escapeHtml(lead.lastName)}</li>
       <li>Email : ${escapeHtml(lead.email)}</li>
       <li>Téléphone : ${escapeHtml(lead.phone)}</li>
       ${detailItems
         .filter(Boolean)
         .map((item) => `<li>${escapeHtml(item)}</li>`)
         .join('\n       ')}
       ${lead.message ? `<li>Message : ${escapeHtml(lead.message)}</li>` : ''}
     </ul>
     <p>Connectez-vous à votre tableau de bord pour répondre au client.</p>`
  );
}

async function sendLeadAcknowledgementEmail(lead, listing) {
  await sendMail(
    lead.email,
    'Votre demande a bien été envoyée - Mounesba',
    `<p>Bonjour ${escapeHtml(lead.firstName)},</p>
     <p>Votre demande de devis pour <strong>${escapeHtml(listing.title)}</strong> a bien été transmise au prestataire.</p>
     <p>Il vous recontactera directement par téléphone ou email dès que possible.</p>`
  );
}

// Contrat et facture prestataire -> client : PDF joint a l'email (jamais un
// lien nu vers le fichier, cf. documentAttachment) + recapitulatif lisible
// dans le corps du message.
async function sendContractEmail(client, contract, listing, pdfUrl) {
  if (!client?.email) return;
  const attachment = documentAttachment(pdfUrl, `Contrat - ${listing.title}.pdf`);
  const amount = Number(contract.amount) || 0;
  await sendMail(
    client.email,
    `Votre contrat - ${listing.title}`,
    `<p>Bonjour ${escapeHtml(client.name)},</p>
     <p>Vous trouverez ci-joint le contrat de <strong>${escapeHtml(listing.title)}</strong> concernant :
     ${escapeHtml(contract.object)}.</p>
     ${amount > 0 ? `<p>Montant : <strong>${amount.toFixed(2)} DT</strong></p>` : ''}
     <p>Le règlement se fait directement avec le prestataire (espèces ou virement), hors plateforme.</p>
     <p>Pour toute question, répondez simplement à cet email.</p>
     <p>Cordialement,<br />${escapeHtml(listing.title)}</p>`,
    { listing, attachments: [attachment] }
  );
}

async function sendInvoiceEmail(client, invoice, listing, pdfUrl) {
  if (!client?.email) return;
  const attachment = documentAttachment(pdfUrl, `Facture ${invoice.number}.pdf`);
  const totals = computeInvoiceTotals(invoice);
  await sendMail(
    client.email,
    `Votre facture ${invoice.number} - ${listing.title}`,
    `<p>Bonjour ${escapeHtml(client.name)},</p>
     <p>Vous trouverez ci-joint la facture n° <strong>${escapeHtml(invoice.number)}</strong> de
     <strong>${escapeHtml(listing.title)}</strong>${invoice.issuedAt ? `, émise le ${formatDateFr(invoice.issuedAt)}` : ''}.</p>
     <p>Total TTC : <strong>${totals.ttc.toFixed(2)} DT</strong>${
       totals.deposit > 0 ? `<br />Acompte versé : ${totals.deposit.toFixed(2)} DT` : ''
     }<br />Reste à payer : <strong>${totals.remaining.toFixed(2)} DT</strong></p>
     <p>Le règlement se fait directement avec le prestataire (espèces ou virement), hors plateforme.</p>
     <p>Pour toute question, répondez simplement à cet email.</p>
     <p>Cordialement,<br />${escapeHtml(listing.title)}</p>`,
    { listing, attachments: [attachment] }
  );
}

async function sendProviderApprovedEmail(user, listing) {
  await sendMail(
    user.email,
    'Votre fiche Mounesba a été validée',
    `<p>Bonjour ${escapeHtml(user.firstName)},</p>
     <p>Bonne nouvelle : votre fiche <strong>${escapeHtml(listing.title)}</strong> a été validée par notre équipe
     et est désormais visible sur Mounesba.</p>`
  );
}

// Identifiants de connexion envoyes au prestataire des la creation de son
// compte par l'admin (adminController.createProvider), en complement de la
// communication manuelle (telephone/SMS/WhatsApp) - reduit le risque
// d'erreur de transcription du mot de passe temporaire.
async function sendProviderAccountCreatedEmail(user, listing, temporaryPassword) {
  const link = buildLoginLink(user.email, temporaryPassword);
  await sendMail(
    user.email,
    'Votre compte prestataire Mounesba a été créé',
    `<p>Bonjour ${escapeHtml(user.firstName)},</p>
     <p>Votre compte prestataire Mounesba a été créé pour votre fiche <strong>${escapeHtml(listing.title)}</strong>.</p>
     <p>Voici vos identifiants de connexion :</p>
     <p>Email : <strong>${user.email}</strong><br />
     Mot de passe temporaire : <strong>${temporaryPassword}</strong></p>
     <p><a href="${link}">Connectez-vous à votre espace prestataire</a> (vos identifiants seront
     pré-remplis) et changez ce mot de passe dès votre première connexion.</p>`
  );
}

// Mot de passe reinitialise par un admin (Super Admin) depuis le dashboard -
// meme format que sendProviderAccountCreatedEmail, le prestataire est invite
// a le changer des sa prochaine connexion.
async function sendProviderPasswordResetEmail(user, temporaryPassword) {
  const link = buildLoginLink(user.email, temporaryPassword);
  await sendMail(
    user.email,
    'Votre mot de passe Mounesba a été réinitialisé',
    `<p>Bonjour ${escapeHtml(user.firstName)},</p>
     <p>Le mot de passe de votre compte prestataire Mounesba a été réinitialisé par un administrateur.</p>
     <p>Voici votre nouveau mot de passe temporaire : <strong>${temporaryPassword}</strong></p>
     <p><a href="${link}">Connectez-vous à votre espace prestataire</a> (vos identifiants seront
     pré-remplis) et changez-le dès votre prochaine connexion.</p>`
  );
}

async function sendProviderRejectedEmail(user, listing, reason) {
  await sendMail(
    user.email,
    'Votre fiche Mounesba nécessite des modifications',
    `<p>Bonjour ${escapeHtml(user.firstName)},</p>
     <p>Votre fiche <strong>${escapeHtml(listing.title)}</strong> n'a pas été validée pour le motif suivant :</p>
     <p><em>${escapeHtml(reason)}</em></p>
     <p>Vous pouvez la mettre à jour depuis votre espace prestataire et la soumettre à nouveau.</p>`
  );
}

// Activation/desactivation d'une fiche par l'admin (Super Admin/Moderateur) —
// envoye a chaque changement de statut, motif optionnel inclus s'il est fourni.
async function sendProviderStatusChangedEmail(user, listing, status, reason) {
  if (!user?.email) return;

  if (status === 'active') {
    await sendMail(
      user.email,
      'Votre fiche Mounesba est de nouveau active',
      `<p>Bonjour ${escapeHtml(user.firstName)},</p>
       <p>Votre fiche <strong>${escapeHtml(listing.title)}</strong> est de nouveau active et visible sur Mounesba.</p>`
    );
    return;
  }

  await sendMail(
    user.email,
    'Votre fiche Mounesba a été suspendue',
    `<p>Bonjour ${escapeHtml(user.firstName)},</p>
     <p>Votre fiche <strong>${escapeHtml(listing.title)}</strong> a été suspendue par notre équipe et n'est
     plus visible sur la plateforme.</p>
     ${reason ? `<p>Motif : <em>${escapeHtml(reason)}</em></p>` : ''}
     <p>Contactez le support si vous pensez qu'il s'agit d'une erreur.</p>`
  );
}

// Prevenu le prestataire quand le client annule sa reservation ou en modifie
// la date depuis son espace client (self-service, cf. bookingController
// cancelMyBooking / updateMyBookingDate) - le prestataire gere son CRM/
// calendrier hors-ligne (CLAUDE.md), il doit donc etre notifie du changement.
async function sendBookingChangedByClientEmail(providerUser, booking, listing, change) {
  if (!providerUser?.email) return;

  const subject =
    change === 'cancelled'
      ? `Réservation annulée par le client — ${listing.title}`
      : `Date de réservation modifiée par le client — ${listing.title}`;

  const body =
    change === 'cancelled'
      ? `<p>Le client a annulé sa réservation pour <strong>${escapeHtml(listing.title)}</strong>
         ${booking.eventDate ? `prévue le ${booking.eventDate}` : ''}.</p>`
      : `<p>Le client a modifié la date de sa réservation pour <strong>${escapeHtml(listing.title)}</strong> :
         nouvelle date le <strong>${booking.eventDate}</strong>.</p>`;

  await sendMail(
    providerUser.email,
    subject,
    `<p>Bonjour ${escapeHtml(providerUser.firstName)},</p>
     ${body}
     <p>Consultez votre espace prestataire pour plus de détails.</p>`
  );
}

// Rappel J-7 avant echeance d'abonnement payant (US-P10, MODULES.md M9).
async function sendSubscriptionExpiryReminderEmail(user, subscription) {
  if (!user?.email) return;

  await sendMail(
    user.email,
    'Votre abonnement Mounesba expire dans 7 jours',
    `<p>Bonjour ${escapeHtml(user.firstName)},</p>
     <p>Votre abonnement <strong>${escapeHtml(subscription.plan)}</strong> arrive à échéance le
     <strong>${subscription.endDate}</strong>.</p>
     <p>Contactez notre équipe pour renouveler votre abonnement et continuer à profiter
     de vos fonctionnalités (le règlement se fait hors plateforme, cash ou virement RIB).</p>`
  );
}

// Facture d'abonnement (admin -> prestataire, M9) : contrairement a
// sendInvoiceEmail (prestataire -> client), toujours envoyee via le SMTP de
// la plateforme (pas de `listing` passe a sendMail) - c'est Mounesba qui
// facture le prestataire, jamais l'inverse.
async function sendSubscriptionInvoiceEmail(owner, invoice, pdfUrl) {
  if (!owner?.email) return;
  const attachment = documentAttachment(pdfUrl, `Facture ${invoice.number}.pdf`);
  const period = invoice.periodStart
    ? `<br />Période : du ${formatDateFr(invoice.periodStart)}${invoice.periodEnd ? ` au ${formatDateFr(invoice.periodEnd)}` : ''}`
    : '';
  await sendMail(
    owner.email,
    `Votre facture d'abonnement ${invoice.number} - Mounesba`,
    `<p>Bonjour ${escapeHtml(owner.firstName)},</p>
     <p>Vous trouverez ci-joint votre facture d'abonnement Mounesba n° <strong>${escapeHtml(invoice.number)}</strong>.</p>
     <p>Montant TTC : <strong>${Number(invoice.amount).toFixed(2)} DT</strong>${period}${
       invoice.dueDate ? `<br />Échéance : ${formatDateFr(invoice.dueDate)}` : ''
     }</p>
     <p>Le règlement se fait hors plateforme (espèces ou virement RIB).</p>
     <p>Pour toute question, répondez simplement à cet email.</p>
     <p>Cordialement,<br />L'équipe Mounesba</p>`,
    { attachments: [attachment] }
  );
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Invitation a laisser un avis verifie (M13 - incitation a confirmer) :
// envoyee au client d'une demande aboutie, apres double confirmation
// (prestataire + admin) et une fois l'evenement passe. Un client sans compte
// est invite a en creer un avec la meme adresse : ses demandes et
// reservations y sont rattachees a la verification de l'email.
async function sendReviewInvitationEmail(lead, listing, { hasAccount }) {
  const base = process.env.FRONTEND_URL;
  const link = hasAccount
    ? `${base}/client/dashboard`
    : `${base}/register?email=${encodeURIComponent(lead.email)}`;
  await sendMail(
    lead.email,
    `Votre avis sur ${listing.title} - Mounesba`,
    `<p>Bonjour ${escapeHtml(lead.firstName)},</p>
     <p>Votre événement avec <strong>${escapeHtml(listing.title)}</strong>, organisé grâce à Mounesba,
     est désormais passé. Votre retour aide d'autres familles à choisir leurs prestataires.</p>
     <p>${
       hasAccount
         ? 'Retrouvez votre réservation dans votre espace client pour laisser un <strong>avis vérifié</strong> :'
         : `Créez votre compte avec l'adresse <strong>${escapeHtml(lead.email)}</strong> : votre réservation y sera
            automatiquement rattachée et vous pourrez laisser un <strong>avis vérifié</strong> :`
     }</p>
     <p><a href="${link}">${link}</a></p>`
  );
}

// Les autres templates (nouvel avis) seront centralisés ici en Phase 10
// (module M12) — voir docs/Prompts.md, Prompt 10.1.

module.exports = {
  sendReviewInvitationEmail,
  sendMail,
  sendTestEmail,
  sendPlatformTestEmail,
  clearPlatformSettingsCache,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendNewLeadEmail,
  sendLeadAcknowledgementEmail,
  sendContractEmail,
  sendInvoiceEmail,
  sendProviderApprovedEmail,
  sendProviderAccountCreatedEmail,
  sendProviderPasswordResetEmail,
  sendProviderRejectedEmail,
  sendProviderStatusChangedEmail,
  sendBookingChangedByClientEmail,
  sendSubscriptionExpiryReminderEmail,
  sendSubscriptionInvoiceEmail,
};
