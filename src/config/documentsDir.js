const os = require('os');
const path = require('path');

// Dossier des PDF generes (contrats/factures). Sur Vercel (serverless) seul
// /tmp est inscriptible, et il est vide a chaque nouvelle instance : un PDF
// absent y est donc regenere a la demande depuis la base (documentController).
const DOCUMENTS_DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), 'documents')
  : path.join(__dirname, '../../uploads/documents');

module.exports = DOCUMENTS_DIR;
