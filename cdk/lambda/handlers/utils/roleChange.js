// Centralized, dependency-free rules for mutating a user's roles.
//
// This module holds every validation and policy check for a role change in one
// pure function so the behavior can be unit tested in isolation and reused by
// any caller. It performs no I/O: the caller supplies the current state and the
// decision is returned as plain data.

const VALID_ROLES = ["admin", "instructor", "student"];
const VALID_OPERATIONS = ["add", "remove"];

/**
 * Decide whether a role change is permitted and compute the resulting roles.
 *
 * Separation-of-duties rules enforced here:
 *  - An admin may not add or remove the `admin` role on their own account, so
 *    privileged access is always granted or revoked by a different person.
 *  - The last remaining `admin` can never be removed, so the system cannot be
 *    left with no administrator.
 *
 * @param {Object} input
 * @param {string[]} input.currentRoles - roles the subject currently holds
 * @param {string} input.operation - "add" or "remove"
 * @param {string} input.role - role being added or removed
 * @param {string} input.actorUserId - id of the acting (authenticated) user
 * @param {string} input.targetUserId - id of the user being modified
 * @param {number} input.totalAdminCount - current number of admins in the system
 * @returns {{allowed: boolean, statusCode?: number, error?: string, rolesAfter?: string[]}}
 */
function evaluateRoleChange({
  currentRoles,
  operation,
  role,
  actorUserId,
  targetUserId,
  totalAdminCount,
}) {
  const roles = Array.isArray(currentRoles) ? currentRoles : [];

  if (!VALID_ROLES.includes(role)) {
    return { allowed: false, statusCode: 400, error: "Invalid role" };
  }

  if (!VALID_OPERATIONS.includes(operation)) {
    return {
      allowed: false,
      statusCode: 400,
      error: "Invalid operation. Use 'add' or 'remove'",
    };
  }

  // Separation of duties: changing one's own admin access is never permitted.
  if (role === "admin" && actorUserId && actorUserId === targetUserId) {
    return {
      allowed: false,
      statusCode: 403,
      error: "You cannot change the admin role on your own account",
    };
  }

  if (operation === "add") {
    // Appending a role the subject already has is a no-op; keep roles as-is.
    const rolesAfter = roles.includes(role) ? roles : [...roles, role];
    return { allowed: true, rolesAfter };
  }

  // operation === "remove"
  if (!roles.includes(role)) {
    return {
      allowed: false,
      statusCode: 400,
      error: "User does not have this role",
    };
  }

  if (roles.length === 1) {
    return {
      allowed: false,
      statusCode: 400,
      error: "Cannot remove the user's only role",
    };
  }

  // Never leave the system without an administrator.
  if (role === "admin" && totalAdminCount <= 1) {
    return {
      allowed: false,
      statusCode: 400,
      error: "Cannot remove the last remaining admin",
    };
  }

  const rolesAfter = roles.filter((r) => r !== role);
  return { allowed: true, rolesAfter };
}

module.exports = { evaluateRoleChange, VALID_ROLES, VALID_OPERATIONS };
