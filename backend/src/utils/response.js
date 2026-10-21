const successResponse = (res, data, message = 'Success') => {
  return res.status(200).json({
    success: true,
    message,
    data,
    ...(res.locals?.traceId ? { traceId: res.locals.traceId } : {}),
  });
};

const errorResponse = (res, message = 'Error', statusCode = 500, code) => {
  return res.status(statusCode).json({
    success: false,
    ...(code ? { code } : {}),
    message,
    error: message,
    ...(res.locals?.traceId ? { traceId: res.locals.traceId } : {}),
  });
};

module.exports = { successResponse, errorResponse };

