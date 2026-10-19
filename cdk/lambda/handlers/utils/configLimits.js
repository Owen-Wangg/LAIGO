// Centralized, dependency-free rules for the AI config usage limits.
//
// These two SSM parameters (message limit and file size limit) are written from
// more than one route, and their consumers coerce the stored string with
// int(...) under fail-closed logic. Keeping the validation in one pure module
// gives every writer a single source of truth and lets the rules be unit tested
// in isolation. The functions perform no I/O and return plain data.

/**
 * Validate a daily message-limit value.
 *
 * Accepts the literal "Infinity" (unlimited) or an integer >= 10. The parseInt
 * semantics match the long-standing dedicated endpoint so existing valid inputs
 * keep working.
 *
 * @param {*} value - raw value from the request body
 * @returns {{valid: boolean, error?: string}}
 */
function validateMessageLimit(value) {
  const error =
    "Message limit must be 'Infinity' or a number greater than or equal to 10";

  if (value === "Infinity") {
    return { valid: true };
  }

  const numLimit = parseInt(value);
  if (isNaN(numLimit) || numLimit < 10) {
    return { valid: false, error };
  }

  return { valid: true };
}

/**
 * Validate a file-size-limit value (in megabytes).
 *
 * Consumers do int(value) to compute a byte ceiling, so only a positive integer
 * is meaningful. Rejects non-numeric strings, empty values, zero, negatives, and
 * non-integer numbers.
 *
 * @param {*} value - raw value from the request body
 * @returns {{valid: boolean, error?: string}}
 */
function validateFileSizeLimit(value) {
  const error =
    "File size limit must be a positive integer representing megabytes";

  if (value === undefined || value === null || value === "") {
    return { valid: false, error };
  }

  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return { valid: false, error };
  }

  return { valid: true };
}

module.exports = { validateMessageLimit, validateFileSizeLimit };
