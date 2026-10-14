// Migration: Enforce one users row per non-null idp_id.
// Identity resolution across the authorizers looks up a single user with
// WHERE idp_id = <sub> and reads the first result, so the column must hold at
// most one row per non-null value for that lookup to be deterministic.
// Replaces the previous non-unique partial index with a unique partial index:
// multiple NULL idp_id values are still permitted, but each non-null identity
// maps to exactly one row.
// Uses a standard (non-concurrent) index so it can run inside node-pg-migrate transactions.

exports.up = async function (pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_users_idp_id;
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
