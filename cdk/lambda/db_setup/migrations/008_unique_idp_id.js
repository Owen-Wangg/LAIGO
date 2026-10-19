// Migration: Enforce one users row per non-null idp_id.
// Identity resolution across the authorizers looks up a single user with
// WHERE idp_id = <sub> and reads the first result, so the column must hold at
// most one row per non-null value for that lookup to be deterministic.
// Replaces the previous non-unique partial index with a unique partial index:
// multiple NULL idp_id values are still permitted, but each non-null identity
// maps to exactly one row.
// Uses a standard (non-concurrent) index so it can run inside node-pg-migrate transactions.
//
// De-duplication: creating the unique index fails if the table already holds
// duplicate non-null idp_id rows, which would abort the whole migration run and
// prevent later migrations (009_create_audit_log) from applying. To avoid that,
// first collapse any duplicates: keep the earliest-created row per idp_id
// (canonical identity) and null out idp_id on the later duplicate rows so the
// unique partial index can be created. This runs inside the migration
// transaction, so the de-dup and index creation apply atomically.

exports.up = async function (pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_users_idp_id;

    -- Null out idp_id on all but the canonical (earliest-created, then
    -- lowest user_id) row for each duplicated non-null idp_id.
    UPDATE users
    SET idp_id = NULL
    WHERE idp_id IS NOT NULL
      AND user_id NOT IN (
        SELECT DISTINCT ON (u.idp_id) u.user_id
        FROM users u
        WHERE u.idp_id IS NOT NULL
        ORDER BY u.idp_id, u.time_account_created ASC, u.user_id ASC
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_idp_id
      ON users (idp_id) WHERE idp_id IS NOT NULL;
  `);
};

exports.down = async function (pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_users_idp_id;
    CREATE INDEX IF NOT EXISTS idx_users_idp_id
      ON users (idp_id) WHERE idp_id IS NOT NULL;
  `);
};
