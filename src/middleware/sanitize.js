const sanitizeHtml = require('sanitize-html');

// Retire toute balise HTML des champs texte libres avant enregistrement en
// base (XSS en defense en profondeur - CLAUDE.md, section Securite). React
// echappe deja le rendu cote frontend (aucun dangerouslySetInnerHTML dans le
// projet), mais une valeur stockee sans balise reste plus sure si elle finit
// un jour dans un export PDF/email HTML qui, lui, n'echappe pas comme JSX.
const STRIP_ALL_TAGS = { allowedTags: [], allowedAttributes: {} };

function stripHtml(value) {
  if (typeof value !== 'string') return value;
  return sanitizeHtml(value, STRIP_ALL_TAGS).trim();
}

// Middleware factory : nettoie en place les champs nommes de req.body
// (presents uniquement, les absents/undefined ne sont pas touches - laisse
// express-validator gerer le "requis"). Ne touche jamais aux emails, URLs et
// champs numeriques (hors scope demande, et sanitize-html n'a rien a y
// retirer).
function sanitizeFields(fields) {
  return (req, res, next) => {
    if (req.body && typeof req.body === 'object') {
      fields.forEach((field) => {
        if (req.body[field] !== undefined && req.body[field] !== null) {
          req.body[field] = stripHtml(req.body[field]);
        }
      });
    }
    next();
  };
}

module.exports = { sanitizeFields, stripHtml };
