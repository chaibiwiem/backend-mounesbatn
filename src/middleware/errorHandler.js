function errorHandler(err, req, res, next) {
  console.error(err);

  const status = err.status || 500;
  const isHiddenServerError = process.env.NODE_ENV === 'production' && status === 500;
  const message = isHiddenServerError
    ? 'Une erreur interne est survenue.'
    : err.message || 'Une erreur interne est survenue.';

  res.status(status).json({ message });
}

module.exports = errorHandler;
