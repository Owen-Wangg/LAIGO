// Migration: Create the audit_log table.
// Records security-critical administrative state changes (role grants, roster
// assignments, prompt activation, model configuration, signup mode, whitelist
// replacement, disclaimer activation) with the acting user, the affected
// subject, and the before/after state. Provides a durable, queryable trail
// that application and gateway logs do not capture.

exports.up = async function (pgm) {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS audit_log (
      audit_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      actor_id uuid,
      actor_email varchar,
      action varchar NOT NULL,
      subject_type varchar,
      subject_id varchar,
      subject_email varchar,
      before_state jsonb,
      after_state jsonb,
      created_at timestamptz DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id ON audit_log (actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_subject_id ON audit_log (subject_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at);
  `);
};

exports.down = async function (pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_audit_log_created_at;
    DROP INDEX IF EXISTS idx_audit_log_subject_id;
    DROP INDEX IF EXISTS idx_audit_log_actor_id;
    DROP TABLE IF EXISTS audit_log;
  `);
};
