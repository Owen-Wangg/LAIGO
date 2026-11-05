# Database Migrations

This document provides comprehensive information about the database migration system used in the LAIGO project.

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Migration System Architecture](#migration-system-architecture)
4. [Migration Files Structure](#migration-files-structure)
5. [How Migrations Work](#how-migrations-work)
6. [Creating New Migrations](#creating-new-migrations)
7. [Common Migration Patterns](#common-migration-patterns)
8. [Running Migrations](#running-migrations)
9. [Migration Patterns and Best Practices](#migration-patterns-and-best-practices)

## Overview

The LAIGO project uses a `node-pg-migrate` system to manage database schema changes with numbered JavaScript files. This provides a reliable, trackable, and automated approach to database schema evolution during first deploy and subsequent stack updates.

## Quick Start

### Creating a New Migration

1. **Find the next migration number:**

   ```bash
   ls cdk/lambda/db_setup/migrations/ | tail -1
   # Use next sequential number (e.g., if last is 009, use 010)
   ```

2. **Create migration file:**

   ```bash
   # Replace XXX with next number and describe_change with description
   touch cdk/lambda/db_setup/migrations/XXX_describe_change.js
   ```

3. **Basic migration template:**

   ```javascript
   exports.up = (pgm) => {
     // Your migration code here
     pgm.sql(`
       -- Your SQL here
     `);
   };

   exports.down = (pgm) => {
     // Optional: rollback logic
   };
   ```

## Migration System Architecture

The migration system is built on `node-pg-migrate` and consists of:

- **Migration Files**: Located in `cdk/lambda/db_setup/migrations/` with numbered JavaScript files
- **Migration Runner**: The `index.js` file contains the migration execution and post-migration setup logic
- **Migration Tracking**: Uses a `pgmigrations` table to track which migrations have been applied
- **Automatic Execution**: Runs during CDK deployments via a `TriggerFunction` in `DBFlowStack`

### Key Components

```
cdk/lambda/db_setup/
├── index.js                                # Main entry point, runs node-pg-migrate + app user setup
└── migrations/                             # Migration files directory
    ├── 000_initial_schema.js
    ├── 001_rename_unlocked_to_completed.js
    ├── 002_add_role_labels.js
    ├── 003_add_summary_prompt_enums.js
    ├── 004_seed_default_system_prompts.js
    ├── 005_seed_default_disclaimer.js
    ├── 006_add_cascade_to_case_reviewers.js
    ├── 007_add_index_cases_student_id.js
    ├── 008_unique_idp_id.js
    └── 009_create_audit_log.js

cdk/lib/dbFlow-stack.ts                     # Defines TriggerFunction that invokes db_setup Lambda on deploy
cdk/layers/node-pg-migrate/package.json     # Layer dependencies (node-pg-migrate, pg)
```

## Migration Files Structure

### JavaScript Migration Files

Each migration file follows this naming convention: `{number}_{description}.js`

**Example Structure:**

```javascript
exports.up = (pgm) => {
  // Forward migration logic
  pgm.sql(`
    ALTER TABLE cases ADD COLUMN example_flag boolean DEFAULT false;
  `);
};

exports.down = (pgm) => {
  // Rollback logic (optional but recommended)
  pgm.sql(`
    ALTER TABLE cases DROP COLUMN IF EXISTS example_flag;
  `);
};
```

### Common Migration Operations

#### Adding Tables

```javascript
exports.up = (pgm) => {
  pgm.createTable("audit_events", {
    event_id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("uuid_generate_v4()"),
    },
    case_id: { type: "uuid", notNull: true },
    event_type: { type: "varchar", notNull: true },
    created_at: { type: "timestamptz", default: pgm.func("now()") },
  });
};
```

#### Adding Columns

```javascript
exports.up = (pgm) => {
  pgm.addColumn("cases", {
    review_notes: {
      type: "text",
      default: "",
      comment: "Supervisor review notes",
    },
  });
};
```

#### Modifying Columns

```javascript
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE cases ALTER COLUMN case_title TYPE text;
  `);
};
```

## How Migrations Work

### Execution Flow

1. **Trigger Creation**: `DBFlowStack` provisions a `triggers.TriggerFunction` (`<StackPrefix>-DBFlowStack-initializerFunction`). Its description includes a build timestamp, so the trigger re-runs on every deploy.
2. **Deployment Invocation**: During `cdk deploy`, the trigger invokes `cdk/lambda/db_setup/index.js`
3. **Secrets Load**: The Lambda reads admin credentials from `DB_SECRET_NAME` in Secrets Manager
4. **Migration Run**: `runMigrations()` executes `node-pg-migrate` in `up` direction against `migrations/` over TLS through the RDS Proxy
5. **Tracking Update**: `node-pg-migrate` records applied files in `pgmigrations`
6. **Post-Migration Setup**: The Lambda creates the `app_rw` and `app_tc` users if they are missing, re-applies the `readwrite` and `tablecreator` grants, makes `audit_log` append-only for those roles, and writes the credentials to the app secrets. Passwords already stored in the secrets are reused; a new password is only generated on first provisioning.

### Migration Tracking

The system uses a PostgreSQL table to track applied migrations:

- **`pgmigrations`**: Used by node-pg-migrate to track which migrations have been successfully applied

### Deployment Process

```mermaid
graph TD
    A[CDK Deploy Updates DBFlowStack] --> B[TriggerFunction Invokes db_setup Lambda]
    B --> C[Read Admin DB Secret]
    C --> D[Run node-pg-migrate on migrations folder]
    D --> E[Apply Pending Migrations in Order]
    E --> F[Record Applied Rows in pgmigrations]
    F --> G[Create or update app_rw and app_tc users and grants]
    G --> H[Write user credentials to Secrets Manager]
```

## Creating New Migrations

### Method 1: JavaScript Migration Files (Recommended)

1. **Determine the next migration number:**

   ```bash
   # Look at existing files in migrations/ directory
   ls cdk/lambda/db_setup/migrations/
   # Use the next sequential number
   ```

2. **Create the migration file:**

   ```bash
   # Example: adding case tags support
   touch cdk/lambda/db_setup/migrations/010_add_case_tags.js
   ```

3. **Write the migration:**

   ```javascript
   exports.up = (pgm) => {
     pgm.createTable("case_tags", {
       case_id: {
         type: "uuid",
         notNull: true,
         references: "cases(case_id)",
         onDelete: "CASCADE",
       },
       tag: {
         type: "varchar",
         notNull: true,
       },
       created_at: { type: "timestamptz", default: pgm.func("now()") },
     });

     // Add indexes
     pgm.createIndex("case_tags", "case_id");
     pgm.createIndex("case_tags", "tag");
   };

   exports.down = (pgm) => {
     pgm.dropTable("case_tags", { ifExists: true, cascade: true });
   };
   ```

## Common Migration Patterns

### Adding a New Table

```javascript
exports.up = (pgm) => {
  pgm.createTable("rubric_templates", {
    template_id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("uuid_generate_v4()"),
    },
    title: { type: "varchar", notNull: true },
    description: { type: "text" },
    status: {
      type: "varchar",
      default: "active",
      check: "status IN ('active', 'inactive')",
    },
    created_at: { type: "timestamptz", default: pgm.func("now()") },
    updated_at: { type: "timestamptz" },
  });

  // Add indexes
  pgm.createIndex("rubric_templates", "title");
};
```

### Adding Columns

```javascript
exports.up = (pgm) => {
  pgm.addColumns("users", {
    preferred_name: {
      type: "varchar",
      default: "",
      notNull: true,
      comment: "Display name for UI",
    },
    notification_preferences: {
      type: "jsonb",
      default: "{}",
    },
  });
};
```

### Modifying Columns

```javascript
exports.up = (pgm) => {
  // Change column type
  pgm.sql(
    `ALTER TABLE cases ALTER COLUMN case_description TYPE varchar(2000);`
  );

  // Add constraint
  pgm.sql(
    `ALTER TABLE users ADD CONSTRAINT users_email_not_blank CHECK (length(trim(user_email)) > 0);`
  );

  // Set default value
  pgm.sql(`ALTER TABLE cases ALTER COLUMN province SET DEFAULT 'N/A';`);
};
```

### Adding Foreign Keys

```javascript
exports.up = (pgm) => {
  pgm.addColumns("case_feedback", {
    reviewed_by: {
      type: "uuid",
      references: "users(user_id)",
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    },
  });

  // Or add constraint to existing column
  pgm.addConstraint("case_feedback", "fk_case_feedback_case", {
    foreignKeys: {
      columns: "case_id",
      references: "cases(case_id)",
      onDelete: "CASCADE",
    },
  });
};
```

### Creating Indexes

```javascript
exports.up = (pgm) => {
  // Simple index
  pgm.createIndex("cases", "status");

  // Composite index
  pgm.createIndex("cases", ["student_id", "status"], {
    name: "idx_cases_student_status",
  });

  // Unique index
  pgm.createIndex("users", "user_email", {
    unique: true,
    name: "idx_users_user_email_unique",
  });

  // Partial index
  pgm.createIndex("messages", "is_read", {
    where: "is_read = false",
    name: "idx_messages_unread",
  });
};
```

### Working with ENUMs

```javascript
exports.up = (pgm) => {
  // Create ENUM type safely
  pgm.sql(`
    DO $$ BEGIN
        CREATE TYPE review_priority AS ENUM ('low', 'medium', 'high');
    EXCEPTION
        WHEN duplicate_object THEN null;
    END $$;
  `);

  // Use in table
  pgm.addColumn("cases", {
    review_priority: {
      type: "review_priority",
      default: "medium",
    },
  });
};
```

### Adding Extensions

```javascript
exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
};
```

### Data Migrations

```javascript
exports.up = (pgm) => {
  // Insert default data
  pgm.sql(`
    INSERT INTO disclaimers (disclaimer_text, version_number, version_name, is_active)
    VALUES ('Default LAIGO disclaimer text.', 1, 'v1', true)
    ON CONFLICT DO NOTHING;
  `);

  // Update existing data
  pgm.sql(`
    UPDATE cases
    SET province = 'N/A'
    WHERE province IS NULL OR province = '';
  `);
};
```

## Running Migrations

### Automatic Execution

Migrations run automatically during:

- **CDK deployment**: `DBFlowStack` `TriggerFunction` executes the `db_setup` Lambda
- **Database initialization**: First-time stack creation
- **Stack updates**: Any deployment that updates/re-runs the trigger resource

### Manual Execution (Development)

For development or troubleshooting:

```bash
# Option 1: invoke the deployed migration Lambda manually
aws lambda invoke \
  --function-name <STACK_PREFIX>-DBFlowStack-initializerFunction \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  /tmp/laigo-db-migration-response.json

# Roll back the most recent migration (runs its exports.down; app users are not touched)
aws lambda invoke \
  --function-name <STACK_PREFIX>-DBFlowStack-initializerFunction \
  --cli-binary-format raw-in-base64-out \
  --payload '{"direction": "down", "count": 1}' \
  /tmp/laigo-db-rollback-response.json
```

The database runs in isolated subnets, so Option 2 below only works from a host inside the VPC (for example, the SageMaker notebook described in the [User Disable / Removal Guide](./userDisableRemovalGuide.md)).

```bash
# Option 2: run node-pg-migrate locally (advanced)
# Install migration dependencies used by the Lambda layer
cd cdk/layers/node-pg-migrate
npm install

# Run migration against a target database
cd ../../lambda/db_setup
NODE_PATH=../../layers/node-pg-migrate/node_modules node -e "
const path = require('path');
const migrate = require('node-pg-migrate').default;
migrate({
  databaseUrl: 'postgresql://user:pass@host:5432/laigo?sslmode=require',
  databaseUrlConfig: { ssl: { rejectUnauthorized: false } },
  dir: path.join(process.cwd(), 'migrations'),
  direction: 'up',
  count: Infinity,
  migrationsTable: 'pgmigrations'
}).then(() => console.log('Done')).catch((e) => { console.error(e); process.exit(1); });
"
```

## Safety Guidelines

### Always Use These Patterns

```javascript
// ✅ Safe table creation
CREATE TABLE IF NOT EXISTS table_name (...);

// ✅ Safe column addition with default
pgm.addColumn('table', {
  column: { type: 'varchar', default: 'value', notNull: true }
});

// ✅ Safe ENUM creation
DO $$ BEGIN
    CREATE TYPE enum_name AS ENUM ('val1', 'val2');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

// ✅ Safe index creation
CREATE INDEX IF NOT EXISTS idx_name ON table (column);
```

### Avoid These Patterns

```javascript
// ❌ Dangerous: Non-nullable without default
pgm.addColumn('table', {
  required_field: { type: 'varchar', notNull: true } // Will fail on existing rows
});

// ❌ Dangerous: Dropping columns (data loss)
pgm.dropColumn('table', 'column');

// ❌ Dangerous: Dropping tables (data loss)
pgm.dropTable('table');

// ❌ Dangerous: Raw SQL without IF NOT EXISTS
CREATE TABLE table_name (...); // Will fail if table exists
```

## Migration Patterns and Best Practices

### 1. Safety First

- **Always use `IF NOT EXISTS`** for CREATE statements where possible
- **Handle duplicate objects gracefully** using `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN null; END $$;`
- **Test migrations in development** before applying to production

### 2. Data Integrity

```javascript
// Good: Safe column addition with default
exports.up = (pgm) => {
  pgm.addColumn("cases", {
    sent_to_review: {
      type: "boolean",
      default: false,
      notNull: true,
    },
  });
};

// Avoid: Non-nullable column without default
exports.up = (pgm) => {
  pgm.addColumn("cases", {
    required_field: { type: "varchar", notNull: true }, // This will fail!
  });
};
```

### 3. Index Management

```javascript
exports.up = (pgm) => {
  // Add table first
  pgm.createTable("large_table", {
    /* ... */
  });

  // Then add indexes
  pgm.createIndex("large_table", "frequently_queried_column");
  pgm.createIndex("large_table", ["composite", "index"], {
    name: "idx_composite_key",
  });
};
```

### 4. Type Safety

```javascript
// Good: Handle ENUM types safely
exports.up = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
        CREATE TYPE new_status AS ENUM ('pending', 'active', 'inactive');
    EXCEPTION
        WHEN duplicate_object THEN null;
    END $$;
  `);
};
```

### 5. Foreign Key Constraints

```javascript
exports.up = (pgm) => {
  pgm.createTable("child_table", {
    id: { type: "uuid", primaryKey: true },
    parent_id: {
      type: "uuid",
      references: "parent_table(id)",
      onDelete: "CASCADE", // or 'SET NULL', 'RESTRICT'
      onUpdate: "CASCADE",
    },
  });
};
```

### 6. Large Data Migrations

For migrations involving large datasets:

```javascript
exports.up = (pgm) => {
  // Use batch processing for large updates
  pgm.sql(`
    UPDATE large_table
    SET new_column = old_column
    WHERE id IN (
      SELECT id FROM large_table
      WHERE new_column IS NULL
      LIMIT 1000
    );
  `);
};
```

## Migration States and Lifecycle

### Migration States

1. **Pending**: Migration file exists but hasn't been applied
2. **Applied**: Migration has been successfully executed and recorded
3. **Failed**: Migration encountered an error during execution

### Rollback Considerations

- **Forward-first approach**: Deployments primarily run migrations in `up` direction
- **Down migrations supported**: `exports.down` can be authored, but production rollback is still an explicit/manual decision
- **Data loss prevention**: Always backup before major schema changes

### Best Practices Summary

1. **Use sequential numbering** for migration files
2. **Keep migrations idempotent where practical** (`IF NOT EXISTS`, duplicate guards)
3. **Provide defaults** when adding `NOT NULL` columns
4. **Test migrations** on development database first
5. **Keep migrations focused** - one logical change per file
6. **Add appropriate indexes** for new columns that will be queried
7. **Document complex migrations** with comments
8. **Consider performance** for large table modifications
9. **Plan rollback strategy** for critical changes
10. **Backup production** before major schema changes

## Getting Help

- Review existing migrations for patterns: `cdk/lambda/db_setup/migrations/`
- Review the migration runner and trigger logic: `cdk/lambda/db_setup/index.js` and `cdk/lib/dbFlow-stack.ts`
- Official node-pg-migrate docs: https://salsita.github.io/node-pg-migrate/
- Test in development environment first
- Ask team for review of complex migrations
- Check PostgreSQL documentation for advanced SQL features

This migration system ensures safe, trackable, and reliable database schema evolution throughout the LAIGO project lifecycle.
