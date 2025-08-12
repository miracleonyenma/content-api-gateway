// ./src/utils/response.js

exports.createResponse = (statusCode, body, additionalHeaders = {}) => {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      ...additionalHeaders,
    },
    body: JSON.stringify(body),
  };
};
