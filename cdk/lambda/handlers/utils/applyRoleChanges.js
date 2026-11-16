// Applies role changes to a user as one guarded transaction. Every role
// mutation uses this so each is checked by the same policy.

const { evaluateRoleChange } = require("./roleChange");

/**
 * Apply one or more role changes to a user as a single guarded transaction.
 *
 * Every role mutation goes through here so each one is checked by the same
 * policy (evaluateRoleChange) against state read under lock. The transaction
 * locks the target row and every admin row, so the admin count cannot change
 * between the decision and the write and two concurrent changes cannot revert
 * each other. The changes are applied in order; if any is not permitted, nothing
 * is written.
 *
 * @param {Function} sqlConnection - postgres connection
 * @param {Object} params
 * @param {string} params.targetUserId - user whose roles change
 * @param {string} params.actorUserId - authenticated administrator
 * @param {{operation: string, role: string}[]} params.changes - ordered changes
 * @returns {Promise<{decision: Object, rolesBefore: string[]}>} the first
 *   rejected decision, or the final allowed decision with `rolesAfter`
 */
async function applyRoleChanges(
  sqlConnection,
  { targetUserId, actorUserId, changes },
) {
  let decision;
  let rolesBefore = [];
  await sqlConnection.begin(async (sql) => {
    const lockedUser = await sql`
      SELECT roles FROM "users" WHERE user_id = ${targetUserId} FOR UPDATE;
    `;
    rolesBefore = lockedUser[0]?.roles || [];
    let currentRoles = rolesBefore;

    const adminRows = await sql`
      SELECT user_id FROM "users" WHERE 'admin' = ANY(roles) FOR UPDATE;
    `;
    let totalAdminCount = adminRows.length;

    for (const { operation, role } of changes) {
      decision = evaluateRoleChange({
        currentRoles,
        operation,
        role,
        actorUserId,
        targetUserId,
        totalAdminCount,
      });

      // Not permitted: stop. Only reads have run so far, so nothing is written
      // and the caller reports the decision.
      if (!decision.allowed) {
        return;
      }

      if (operation === "add") {
        // Append role only if not already present
        if (!currentRoles.includes(role)) {
          await sql`
            UPDATE "users"
            SET roles = array_append(roles, ${role}::user_role)
            WHERE user_id = ${targetUserId};
          `;
        }
      } else {
        await sql`
          UPDATE "users"
          SET roles = array_remove(roles, ${role}::user_role)
          WHERE user_id = ${targetUserId};
        `;

        // Clean up instructor assignments when instructor role is removed
        if (role === "instructor") {
          await sql`
            DELETE FROM "instructor_students"
            WHERE instructor_id = ${targetUserId};
          `;
        }

        if (role === "admin") {
          totalAdminCount -= 1;
        }
      }
      currentRoles = decision.rolesAfter;
    }
  });
  return { decision, rolesBefore };
}

module.exports = { applyRoleChanges };
