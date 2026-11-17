// Durable audit trail shared by the admin, instructor and student handlers.

const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "Audit" });

/**
 * Persist a durable record of a security-critical change.
 *
 * Writes one row to audit_log capturing the acting user, the affected subject,
 * and the before/after state. Failures here are logged but never propagated:
 * an audit write must not break the underlying mutation it accompanies.
 *
 * @param {Function} sqlConnection - postgres tagged-template connection
 * @param {Object} entry
 * @param {string} [entry.actorId] - acting user's id
 * @param {string} [entry.actorEmail] - acting user's email
 * @param {string} entry.action - machine-readable action name
 * @param {string} [entry.subjectType] - type of the affected subject
 * @param {string} [entry.subjectId] - id of the affected subject
 * @param {string} [entry.subjectEmail] - email of the affected subject
 * @param {*} [entry.before] - state before the change (serialized to jsonb)
 * @param {*} [entry.after] - state after the change (serialized to jsonb)
 */
async function recordAudit(sqlConnection, entry) {
  try {
    const before =
      entry.before === undefined || entry.before === null
        ? null
        : JSON.stringify(entry.before);
    const after =
      entry.after === undefined || entry.after === null
        ? null
        : JSON.stringify(entry.after);

    await sqlConnection`
      INSERT INTO audit_log (
        actor_id, actor_email, action,
        subject_type, subject_id, subject_email,
        before_state, after_state
      ) VALUES (
        ${entry.actorId ?? null}, ${entry.actorEmail ?? null}, ${entry.action},
        ${entry.subjectType ?? null}, ${entry.subjectId ?? null}, ${entry.subjectEmail ?? null},
        ${before}::jsonb, ${after}::jsonb
      );
    `;
  } catch (err) {
    logger.error("Failed to write audit record", {
      action: entry?.action,
      errorMessage: err?.message,
    });
  }
}

// Request values are attacker-controlled, so cap how much of one is stored.
const MAX_ATTEMPTED_VALUE_LENGTH = 64;

/**
 * Persist a record of a role change that the policy refused.
 *
 * audit_log has no outcome column, so the outcome is carried in two places:
 * the action name gets a `.denied` suffix (so denials can be selected by
 * action), and after_state holds `outcome: "denied"` with the reason, the HTTP
 * status and the attempted changes. before_state holds the subject's roles,
 * which were left unchanged.
 *
 * @param {Function} sqlConnection - postgres tagged-template connection
 * @param {Object} entry
 * @param {string} entry.action - action that was attempted (for example
 *   `user_role.update`)
 * @param {string} [entry.actorId] - acting user's id
 * @param {string} [entry.actorEmail] - acting user's email
 * @param {string} [entry.subjectId] - id of the user the change targeted
 * @param {string} [entry.subjectEmail] - email of the user the change targeted
 * @param {string[]} [entry.rolesBefore] - the subject's roles
 * @param {{operation: string, role: string}[]} entry.attempted - requested changes
 * @param {{statusCode?: number, error?: string}} entry.decision - the refusal
 */
async function recordDeniedRoleChange(sqlConnection, entry) {
  const clip = (value) => String(value ?? "").slice(0, MAX_ATTEMPTED_VALUE_LENGTH);
  await recordAudit(sqlConnection, {
    actorId: entry.actorId,
    actorEmail: entry.actorEmail,
    action: `${entry.action}.denied`,
    subjectType: "user",
    subjectId: entry.subjectId,
    subjectEmail: entry.subjectEmail,
    before: { roles: entry.rolesBefore ?? [] },
    after: {
      outcome: "denied",
      reason: entry.decision?.error,
      statusCode: entry.decision?.statusCode,
      attempted: (entry.attempted ?? []).map(({ operation, role }) => ({
        operation: clip(operation),
        role: clip(role),
      })),
    },
  });
}
module.exports = { recordAudit, recordDeniedRoleChange };
