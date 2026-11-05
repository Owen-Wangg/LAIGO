// Shared parsing for page/limit query parameters on list endpoints.
//
// The values are bound into SQL LIMIT/OFFSET, so they are clamped here to a
// non-negative page and a bounded page size. Missing or non-numeric values
// fall back to the defaults instead of reaching the database as NaN.

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Parse and clamp pagination parameters.
 *
 * @param {Object} [params] - query string parameters
 * @param {Object} [options]
 * @param {number} [options.defaultLimit=10] - page size when none is given
 * @param {number} [options.maxLimit=100] - largest page size accepted
 * @returns {{page: number, limit: number, offset: number}}
 */
function parsePagination(params = {}, options = {}) {
  const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = options.maxLimit ?? MAX_LIMIT;

  const rawPage = parseInt((params || {}).page, 10);
  const rawLimit = parseInt((params || {}).limit, 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, maxLimit)
    : defaultLimit;

  return { page, limit, offset: page * limit };
}

module.exports = { parsePagination, DEFAULT_LIMIT, MAX_LIMIT };
