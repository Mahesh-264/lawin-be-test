const hasUnsafeKey = (value) => {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key.startsWith('$') || key.includes('.') || hasUnsafeKey(child));
};

module.exports = (req, res, next) => {
  if (hasUnsafeKey(req.body)) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid request data.' });
  }
  return next();
};
