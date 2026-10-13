const { body } = require('express-validator');

// Liens saisis par le prestataire (site web, reseaux sociaux, Google Maps)
// affiches tels quels dans un href sur la fiche publique : un lien
// "javascript:..." ou "data:..." y executerait du code au clic (XSS). On
// n'accepte donc que http(s), ou une adresse sans schema ("www.site.tn",
// completee en https:// cote frontend, cf. utils/safeUrl.js).
const LISTING_URL_FIELDS = [
  'website',
  'googleMapsUrl',
  'facebookUrl',
  'instagramUrl',
  'tiktokUrl',
  'linkedinUrl',
  'whatsappUrl',
];

function isSafeUrl(value) {
  const url = String(value).trim();
  if (/\s/.test(url)) return false;
  if (/^https?:\/\//i.test(url)) return true;
  // Tout autre "schema:" (javascript:, data:, vbscript:...) est refuse.
  return !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

const safeUrlValidators = LISTING_URL_FIELDS.map((field) =>
  body(field)
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Lien trop long.')
    .custom(isSafeUrl)
    .withMessage('Lien invalide : seuls les liens http:// ou https:// sont acceptés.')
);

module.exports = { safeUrlValidators, isSafeUrl, LISTING_URL_FIELDS };
