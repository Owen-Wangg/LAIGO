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

module.exports = { recordAudit };
