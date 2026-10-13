// Erreurs d'upload (multer) : ce sont des erreurs du client (fichier trop
// volumineux, trop de fichiers, mauvais champ), pas des erreurs serveur -
// sans ce traitement elles remontaient en 500 "Une erreur interne est
// survenue" au lieu d'un message clair.
const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: 'Fichier trop volumineux (5 Mo maximum pour une image, 50 Mo pour une vidéo).',
  LIMIT_FILE_COUNT: 'Trop de fichiers envoyés en une fois.',
  LIMIT_UNEXPECTED_FILE: 'Fichier envoyé dans un champ inattendu (ou trop de fichiers).',
  LIMIT_PART_COUNT: 'Formulaire trop volumineux.',
  LIMIT_FIELD_KEY: 'Formulaire invalide.',
  LIMIT_FIELD_VALUE: 'Un champ du formulaire est trop long.',
  LIMIT_FIELD_COUNT: 'Trop de champs dans le formulaire.',
};

function errorHandler(err, req, res, next) {
  if (err.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ message: MULTER_MESSAGES[err.code] || 'Fichier invalide.' });
  }

  // Corps JSON mal forme ou trop volumineux (express.json) : erreurs client,
  // message en francais plutot que le texte anglais de body-parser.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Requête invalide (données mal formées).' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Données envoyées trop volumineuses.' });
  }

  console.error(err);

  const status = err.status || err.statusCode || 500;
  const isHiddenServerError = process.env.NODE_ENV === 'production' && status >= 500;
  const message = isHiddenServerError
    ? 'Une erreur interne est survenue.'
    : err.message || 'Une erreur interne est survenue.';

  return res.status(status).json({ message });
}

module.exports = errorHandler;
