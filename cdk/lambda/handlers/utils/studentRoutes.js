"use strict";
/**
 * Role rules for the /student/* routes, enforced inside the student handler as
 * a second layer behind the Lambda authorizer.
 *
 * The route lists must match studentAuthorizerFunction.js; a unit test compares
 * them so the two cannot drift apart.
 */

// Available to any authenticated user, whatever roles they hold.
const SHARED_ROUTES = new Set([
  "GET /student/profile",
  "GET /student/role_labels",
  "GET /student/get_disclaimer",
  "POST /student/accept_disclaimer",
]);

// Available to instructors for case detail views. Handlers still check the
// instructor-student relationship.
const INSTRUCTOR_CASE_ROUTES = new Set([
  "GET /student/case_page",
  "GET /student/get_transcriptions",
  "GET /student/transcription",
  "GET /student/get_summaries",
  "GET /student/feedback",
  "GET /student/get_messages",
  "GET /student/file_size_limit",
]);

/**
 * @param {string} routeKey - "METHOD /resource", for example "GET /student/profile"
 * @param {string[]} roles - roles from the authorizer context
 * @returns {boolean} whether a caller with these roles may use the route
 */
function isRouteAllowedForRoles(routeKey, roles) {
  const held = Array.isArray(roles) ? roles : [];
  if (held.includes("student")) return true;
  if (SHARED_ROUTES.has(routeKey)) return true;
  return held.includes("instructor") && INSTRUCTOR_CASE_ROUTES.has(routeKey);
}

module.exports = {
  isRouteAllowedForRoles,
  SHARED_ROUTES,
  INSTRUCTOR_CASE_ROUTES,
};