function errorHandler(err, req, res, next) {
  console.error(err);

  const status = err.status || 500;
  const isHiddenServerError = process.env.NODE_ENV === 'production' && status === 500;
  const message = isHiddenServerError
    ? 'Une erreur interne est survenue.'
    : err.message || 'Une erreur interne est survenue.';

  // Code technique seul (ex. ER_CON_COUNT_ERROR, SequelizeConnectionError),
  // jamais le message detaille : permet de diagnostiquer une erreur 500 en
  // production sans exposer de details internes.
  const code = status === 500 ? err.parent?.code || err.original?.code || err.code || err.name : undefined;

  res.status(status).json(code ? { message, code } : { message });
}

module.exports = errorHandler;
