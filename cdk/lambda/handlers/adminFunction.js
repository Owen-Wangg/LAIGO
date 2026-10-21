const {
  initConnection,
  createResponse,
  parseBody,
  handleError,
  getSqlConnection,
} = require("./utils/utils");
const {
  isValidWhitelistKey,
  parseWhitelistCsv,
  computeWhitelistReconciliation,
} = require("./utils/whitelistUpload");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "AdminFunction" });

/**
 * Persist a durable record of a security-critical administrative change.
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

const {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} = require("@aws-sdk/client-ssm");

const { evaluateRoleChange } = require("./utils/roleChange");
const {
  validateMessageLimit,
  validateFileSizeLimit,
} = require("./utils/configLimits");

/**
 * Publish a notification about a security-relevant administrative event to the
 * security alerts topic so privileged changes are never silent.
 *
 * The topic ARN is read from SECURITY_ALERTS_TOPIC_ARN. When it is unset the
 * call is skipped with a warning, and any publish failure is swallowed and
 * logged — notifying must never break the underlying mutation it accompanies.
 *
 * @param {Object} entry
 * @param {string} entry.action - machine-readable action name
 * @param {string} [entry.actorId]
 * @param {string} [entry.actorEmail]
 * @param {string} [entry.subjectId]
 * @param {string} [entry.subjectEmail]
 * @param {Object} [entry.detail] - extra structured context
 */
async function notifySecurityEvent(entry) {
  const topicArn = process.env.SECURITY_ALERTS_TOPIC_ARN;
  if (!topicArn) {
    logger.warn(
      "SECURITY_ALERTS_TOPIC_ARN not set, skipping security notification",
      { action: entry?.action },
    );
    return;
  }

  try {
    const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
    const sns = new SNSClient();
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: `Admin role change: ${entry.action}`,
        Message: JSON.stringify(
          {
            action: entry.action,
            actorId: entry.actorId ?? null,
            actorEmail: entry.actorEmail ?? null,
            subjectId: entry.subjectId ?? null,
            subjectEmail: entry.subjectEmail ?? null,
            detail: entry.detail ?? null,
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
      }),
    );
  } catch (err) {
    logger.error("Failed to publish security notification", {
      action: entry?.action,
      errorMessage: err?.message,
    });
  }
}

let {
  MESSAGE_LIMIT,
  FILE_SIZE_LIMIT,
  CASE_TYPES_PARAM,
  BEDROCK_LLM_PARAM,
  BEDROCK_MODEL_OPTIONS_PARAM,
  BEDROCK_TEMP_PARAM,
  BEDROCK_TOP_P_PARAM,
  BEDROCK_MAX_TOKENS_PARAM,
} = process.env;

const FALLBACK_MODEL_OPTIONS = [
  {
    label: "Claude Sonnet 5.5",
    value: "us.anthropic.claude-sonnet-5-5",
    constraints: {
      maxOutputTokens: 128000,
      defaultMaxOutputTokens: 4096,
      temperatureRange: [0, 1.0],
      topPRange: [0, 1.0],
    },
  },
  {
    label: "Llama 3 70b Instruct",
    value: "meta.llama3-70b-instruct-v1:0",
    constraints: {
      maxOutputTokens: 8192,
      defaultMaxOutputTokens: 2000,
      temperatureRange: [0, 1.0],
      topPRange: [0, 1.0],
    },
  },
];

const FALLBACK_CASE_TYPES = ["Other"];

const parseModelOptions = (rawValue) => {
  if (!rawValue) {
    return FALLBACK_MODEL_OPTIONS;
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return FALLBACK_MODEL_OPTIONS;
    }

    const cleaned = parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        label: typeof item.label === "string" ? item.label : String(item.value || "Model"),
        value: typeof item.value === "string" ? item.value : "",
        ...(item.constraints && typeof item.constraints === "object" && {
          constraints: item.constraints,
        }),
      }))
      .filter((item) => item.value.length > 0);

    return cleaned.length > 0 ? cleaned : FALLBACK_MODEL_OPTIONS;
  } catch (error) {
    logger.warn("Failed to parse Bedrock model options parameter", {
      error: error.message,
    });
    return FALLBACK_MODEL_OPTIONS;
  }
};

const parseCaseTypes = (rawValue) => {
  if (!rawValue) {
    return FALLBACK_CASE_TYPES;
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return FALLBACK_CASE_TYPES;
    }

    const cleaned = parsed
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);

    const unique = [...new Set(cleaned)];
    return unique.length > 0 ? unique : FALLBACK_CASE_TYPES;
  } catch (error) {
    logger.warn("Failed to parse allowed case types parameter", {
      error: error.message,
    });
    return FALLBACK_CASE_TYPES;
  }
};

const isValidCaseTypesPayload = (caseTypes) => {
  if (!Array.isArray(caseTypes) || caseTypes.length === 0) {
    return false;
  }

  const seen = new Set();
  for (const caseType of caseTypes) {
    if (typeof caseType !== "string") {
      return false;
    }
    const normalized = caseType.trim();
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
  }
  return true;
};

const validateConfigAgainstModelConstraints = (modelId, config, modelOptions) => {
  const model = modelOptions.find((m) => m.value === modelId);
  if (!model || !model.constraints) {
    return { valid: true };
  }

  const constraints = model.constraints;
  const errors = [];

  if (
    config.max_tokens !== undefined &&
    (!Number.isFinite(config.max_tokens) ||
      config.max_tokens < 1 ||
      config.max_tokens > constraints.maxOutputTokens)
  ) {
    errors.push(
      `max_tokens must be between 1 and ${constraints.maxOutputTokens} for ${model.label}`,
    );
  }

  if (
    config.temperature !== undefined &&
    (config.temperature < constraints.temperatureRange[0] ||
      config.temperature > constraints.temperatureRange[1])
  ) {
    errors.push(
      `temperature must be between ${constraints.temperatureRange[0]} and ${constraints.temperatureRange[1]} for ${model.label}`,
    );
  }

  if (
    config.top_p !== undefined &&
    (config.top_p < constraints.topPRange[0] ||
      config.top_p > constraints.topPRange[1])
  ) {
    errors.push(
      `top_p must be between ${constraints.topPRange[0]} and ${constraints.topPRange[1]} for ${model.label}`,
    );
  }

  return {
    valid: errors.length === 0,
    errors: errors,
    constraints: constraints,
  };
};

const routes = {
  "GET /admin/instructors": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      // SQL query to fetch all users who are instructors
      const instructors = await sqlConnection`
            SELECT user_email, first_name, last_name, user_id
            FROM "users"
            WHERE 'instructor' = ANY(roles)
            ORDER BY last_name ASC;
          `;

      response.body = JSON.stringify(instructors);
    } catch (err) {
      console.error("Database error:", err);
      handleError(err, response);
    }
  },
  "POST /admin/assign_instructor_to_student": async (event, env) => {
    const { response, sqlConnection } = env;
    // Check if the body contains the instructor and student IDs
    if (event.body) {
      try {
        const { instructor_id, student_email } = parseBody(event.body); // Parse the request body to access the JSON data

        if (!instructor_id || !student_email) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Both instructor_id and student_email are required",
          });
          return;
        }

        // Look up student_id from email and verify it's a student
        const studentLookup = await sqlConnection`
              SELECT user_id, roles FROM "users" WHERE user_email = ${student_email};
            `;

        if (studentLookup.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({
            error: "Student not found with that email.",
          });
          return;
        }

        const student = studentLookup[0];

        // Prevent self-assignment (a user with both roles assigning themselves)
        if (instructor_id === student.user_id) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "An instructor cannot be assigned as their own student.",
          });
          return;
        }

        // Perform the database insertion
        await sqlConnection`
                INSERT INTO "instructor_students" (instructor_id, student_id)
                VALUES ( ${instructor_id}, ${student.user_id})
                ON CONFLICT (instructor_id, student_id) DO NOTHING;
              `;

        await recordAudit(sqlConnection, {
          actorId: env.user_id,
          actorEmail: env.user?.email,
          action: "instructor_student.assign",
          subjectType: "user",
          subjectId: student.user_id,
          subjectEmail: student_email,
          after: { instructor_id, student_id: student.user_id },
        });

        response.statusCode = 200;
        response.body = JSON.stringify({
          message: "Instructor and student linked successfully.",
        });
      } catch (err) {
        response.statusCode = 500;
        console.error(err);
        response.body = JSON.stringify({ error: "Internal server error" });
      }
    } else {
      response.statusCode = 400;
      response.body = JSON.stringify({ error: "Request body is missing" });
    }
  },
  "DELETE /admin/assign_instructor_to_student": async (event, env) => {
    const { response, sqlConnection } = env;
    if (event.queryStringParameters) {
      try {
        const { instructor_id, student_id } = event.queryStringParameters;

        if (!instructor_id || !student_id) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Both instructor_id and student_id are required",
          });
          return;
        }

        await sqlConnection`
              DELETE FROM "instructor_students"
              WHERE instructor_id = ${instructor_id} AND student_id = ${student_id};
            `;

        await recordAudit(sqlConnection, {
          actorId: env.user_id,
          actorEmail: env.user?.email,
          action: "instructor_student.unassign",
          subjectType: "user",
          subjectId: student_id,
          after: { instructor_id, student_id },
        });

        response.statusCode = 200;
        response.body = JSON.stringify({
          message: "Student unassigned successfully.",
        });
      } catch (err) {
        response.statusCode = 500;
        console.error(err);
        response.body = JSON.stringify({ error: "Internal server error" });
      }
    } else {
      response.statusCode = 400;
      response.body = JSON.stringify({ error: "Query parameters missing" });
    }
  },
  "GET /admin/students": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      // SQL query to fetch all users who are instructors
      const students = await sqlConnection`
            SELECT user_email, first_name, last_name, user_id
            FROM "users"
            WHERE 'student' = ANY(roles)
            ORDER BY last_name ASC;
          `;

      response.body = JSON.stringify(students);
    } catch (err) {
      console.error("Database error:", err);
      handleError(err, response);
    }
  },
  "GET /admin/users": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      const params = event.queryStringParameters || {};
      const page = parseInt(params.page || "0", 10);
      const limit = parseInt(params.limit || "10", 10);
      const offset = page * limit;
      const search = params.search ? `%${params.search}%` : null;
      const role = params.role && params.role !== "all" ? params.role : null;

      let dataQuery;
      let countQuery;

      if (search && role) {
        countQuery = sqlConnection`
              SELECT COUNT(*) as exact_count FROM "users"
              WHERE (first_name ILIKE ${search} OR last_name ILIKE ${search} OR user_email ILIKE ${search})
              AND ${role} = ANY(roles);
            `;
        dataQuery = sqlConnection`
              SELECT user_email, first_name, last_name, user_id, roles
              FROM "users"
              WHERE (first_name ILIKE ${search} OR last_name ILIKE ${search} OR user_email ILIKE ${search})
              AND ${role} = ANY(roles)
              ORDER BY last_name ASC
              LIMIT ${limit} OFFSET ${offset};
            `;
      } else if (search) {
        countQuery = sqlConnection`
              SELECT COUNT(*) as exact_count FROM "users"
              WHERE (first_name ILIKE ${search} OR last_name ILIKE ${search} OR user_email ILIKE ${search});
            `;
        dataQuery = sqlConnection`
              SELECT user_email, first_name, last_name, user_id, roles
              FROM "users"
              WHERE (first_name ILIKE ${search} OR last_name ILIKE ${search} OR user_email ILIKE ${search})
              ORDER BY last_name ASC
              LIMIT ${limit} OFFSET ${offset};
            `;
      } else if (role) {
        countQuery = sqlConnection`
              SELECT COUNT(*) as exact_count FROM "users"
              WHERE ${role} = ANY(roles);
            `;
        dataQuery = sqlConnection`
              SELECT user_email, first_name, last_name, user_id, roles
              FROM "users"
              WHERE ${role} = ANY(roles)
              ORDER BY last_name ASC
              LIMIT ${limit} OFFSET ${offset};
            `;
      } else {
        countQuery = sqlConnection`
              SELECT COUNT(*) as exact_count FROM "users";
            `;
        dataQuery = sqlConnection`
              SELECT user_email, first_name, last_name, user_id, roles
              FROM "users"
              ORDER BY last_name ASC
              LIMIT ${limit} OFFSET ${offset};
            `;
      }

      const [countResult, users] = await Promise.all([countQuery, dataQuery]);
      const totalCount = parseInt(countResult[0].exact_count, 10);

      response.body = JSON.stringify({ users, totalCount });
    } catch (err) {
      console.error("Database error:", err);
      handleError(err, response);
    }
  },
  "PUT /admin/user_role": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      if (!event.body) throw new Error("Request body is missing");
      const { email: userEmail, operation, role } = parseBody(event.body);

      if (!userEmail || !operation || !role) {
        response.statusCode = 400;
        response.body = JSON.stringify({
          error: "email, operation, and role are required",
        });
        return;
      }

      const existingUser = await sqlConnection`
            SELECT user_id, roles FROM "users" WHERE user_email = ${userEmail};
          `;

      if (existingUser.length === 0) {
        response.statusCode = 404;
        response.body = JSON.stringify({ error: "User not found" });
        return;
      }

      const userIdToUpdate = existingUser[0].user_id;

      // Run the admin-count check and the role update in a single transaction,
      // locking the target row and every admin row, so the admin count cannot
      // change between the decision and the write. This closes the race where
      // two concurrent removals could each see a safe count and together drop
      // the last administrator.
      let decision;
      let currentRoles = [];
      await sqlConnection.begin(async (sql) => {
        const lockedUser = await sql`
              SELECT roles FROM "users" WHERE user_id = ${userIdToUpdate} FOR UPDATE;
            `;
        currentRoles = lockedUser[0]?.roles || [];

        const adminRows = await sql`
              SELECT user_id FROM "users" WHERE 'admin' = ANY(roles) FOR UPDATE;
            `;
        const totalAdminCount = adminRows.length;

        decision = evaluateRoleChange({
          currentRoles,
          operation,
          role,
          actorUserId: env.user_id,
          targetUserId: userIdToUpdate,
          totalAdminCount,
        });

        // Not permitted: make no changes and let the transaction commit the
        // read-only locks. The response is derived from `decision` below.
        if (!decision.allowed) {
          return;
        }

        if (operation === "add") {
          // Append role only if not already present
          if (!currentRoles.includes(role)) {
            await sql`
                  UPDATE "users"
                  SET roles = array_append(roles, ${role}::user_role)
                  WHERE user_id = ${userIdToUpdate};
                `;
          }
        } else {
          await sql`
                UPDATE "users"
                SET roles = array_remove(roles, ${role}::user_role)
                WHERE user_id = ${userIdToUpdate};
              `;

          // Clean up instructor assignments when instructor role is removed
          if (role === "instructor") {
            await sql`
                  DELETE FROM "instructor_students"
                  WHERE instructor_id = ${userIdToUpdate};
                `;
          }
        }
      });

      if (!decision.allowed) {
        response.statusCode = decision.statusCode;
        response.body = JSON.stringify({ error: decision.error });
        return;
      }

      const rolesAfter = decision.rolesAfter;

      await recordAudit(sqlConnection, {
        actorId: env.user_id,
        actorEmail: env.user?.email,
        action: "user_role.update",
        subjectType: "user",
        subjectId: userIdToUpdate,
        subjectEmail: userEmail,
        before: { roles: currentRoles },
        after: { roles: rolesAfter },
      });

      // Surface changes to admin access on the security channel so a grant or
      // removal of the admin role is never silent.
      if (role === "admin") {
        await notifySecurityEvent({
          action: "user_role.update",
          actorId: env.user_id,
          actorEmail: env.user?.email,
          subjectId: userIdToUpdate,
          subjectEmail: userEmail,
          detail: { operation, role, rolesAfter },
        });
      }

      response.statusCode = 200;
      response.body = JSON.stringify({
        success: true,
        message: "User role updated successfully",
      });
    } catch (err) {
      console.error("Database error:", err);
      handleError(err, response);
    }
  },
  "POST /admin/prompt": async (event, env) => {
    const { response, user_id, sqlConnection } = env;
    try {
      console.log("System prompt creation initiated");

      if (!event.body) throw new Error("Request body is missing");

      const { category, block_type, prompt_text, version_name, prompt_scope } =
        parseBody(event.body);

      // Authorship is derived from the authenticated caller, not the request body.
      const promptAuthorId = user_id;
      const resolvedScope = prompt_scope || 'block';

      if (!category || !prompt_text)
        throw new Error(
          "Missing required fields: category and prompt_text are required",
        );

      if (resolvedScope === 'block' && !block_type)
        throw new Error(
          "Missing required field: block_type is required for block-scope prompts",
        );

      // Get the next version number for this category/block_type/scope combination
      let versionCheck;
      if (resolvedScope === 'full_case') {
        versionCheck = await sqlConnection`
              SELECT COALESCE(MAX(version_number), 0) + 1 as next_version
              FROM "prompt_versions"
              WHERE category = ${category} AND prompt_scope = 'full_case';
            `;
      } else {
        versionCheck = await sqlConnection`
              SELECT COALESCE(MAX(version_number), 0) + 1 as next_version
              FROM "prompt_versions"
              WHERE category = ${category} AND block_type = ${block_type} AND prompt_scope = 'block';
            `;
      }

      const nextVersion = versionCheck[0].next_version;

      // Insert new prompt into prompt_versions table
      const insertPrompt = await sqlConnection`
            INSERT INTO "prompt_versions" (category, block_type, prompt_scope, version_number, version_name, prompt_text, author_id, is_active)
            VALUES (${category}, ${block_type || null}, ${resolvedScope}, ${nextVersion}, ${
              version_name || null
            }, ${prompt_text}, ${promptAuthorId || null}, false)
            RETURNING *;
          `;

      await recordAudit(sqlConnection, {
        actorId: user_id,
        actorEmail: env.user?.email,
        action: "prompt.create",
        subjectType: "prompt_version",
        subjectId: insertPrompt[0].prompt_version_id,
        after: {
          category,
          block_type: block_type || null,
          prompt_scope: resolvedScope,
          version_number: nextVersion,
          version_name: version_name || null,
        },
      });

      response.body = JSON.stringify(insertPrompt[0]);
    } catch (err) {
      console.error("Error inserting prompt version:", err);
      handleError(err, response);
    }
  },
  "PUT /admin/prompt": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      console.log("Prompt version update initiated");

      if (!event.body) throw new Error("Request body is missing");

      const { prompt_version_id, prompt_text, version_name } = parseBody(
        event.body,
      );

      if (!prompt_version_id)
        throw new Error("Missing required field: prompt_version_id");

      if (!prompt_text && !version_name)
        throw new Error(
          "At least one field to update is required: prompt_text or version_name",
        );

      // Check if prompt exists
      const existingPrompt = await sqlConnection`
            SELECT prompt_version_id FROM "prompt_versions"
            WHERE prompt_version_id = ${prompt_version_id};
          `;

      if (existingPrompt.length === 0) {
        response.statusCode = 404;
        throw new Error("Prompt version not found");
      }

      // Update the prompt
      const updateResult = await sqlConnection`
            UPDATE "prompt_versions"
            SET 
              prompt_text = COALESCE(${prompt_text || null}, prompt_text),
              version_name = COALESCE(${version_name || null}, version_name)
            WHERE prompt_version_id = ${prompt_version_id}
            RETURNING *;
          `;

      response.body = JSON.stringify(updateResult[0]);
    } catch (err) {
      console.error("Error updating prompt version:", err);
      handleError(err, response);
    }
  },
  "GET /admin/prompt": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      const { category, block_type, prompt_scope } = event.queryStringParameters || {};

      let prompts;
      if (category && prompt_scope === 'full_case') {
        // Fetch full-case prompts for this category
        prompts = await sqlConnection`
              SELECT 
                pv.prompt_version_id,
                pv.category,
                pv.block_type,
                pv.prompt_scope,
                pv.version_number,
                pv.version_name,
                pv.prompt_text,
                pv.author_id,
                pv.time_created,
                pv.is_active,
                NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS author_name
              FROM "prompt_versions" pv
              LEFT JOIN "users" u ON pv.author_id = u.user_id
              WHERE pv.category = ${category} AND pv.prompt_scope = 'full_case'
              ORDER BY pv.version_number DESC;
            `;
      } else if (category && block_type) {
        // Fetch prompts for specific block
        prompts = await sqlConnection`
              SELECT 
                pv.prompt_version_id,
                pv.category,
                pv.block_type,
                pv.prompt_scope,
                pv.version_number,
                pv.version_name,
                pv.prompt_text,
                pv.author_id,
                pv.time_created,
                pv.is_active,
                NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS author_name
              FROM "prompt_versions" pv
              LEFT JOIN "users" u ON pv.author_id = u.user_id
              WHERE pv.category = ${category} AND pv.block_type = ${block_type}
              ORDER BY pv.version_number DESC;
            `;
      } else {
        // Fetch ALL prompt versions (Original behavior)
        prompts = await sqlConnection`
              SELECT 
                pv.prompt_version_id,
                pv.category,
                pv.block_type,
                pv.version_number,
                pv.version_name,
                pv.prompt_text,
                pv.author_id,
                pv.time_created,
                pv.is_active,
                NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS author_name
              FROM "prompt_versions" pv
              LEFT JOIN "users" u ON pv.author_id = u.user_id
              ORDER BY pv.category, pv.block_type, pv.version_number DESC;
            `;
      }

      response.body = JSON.stringify(prompts);
    } catch (err) {
      console.error("Error fetching prompt versions:", err);
      handleError(err, response);
    }
  },
  "GET /admin/prompt/active": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      // Fetch only active prompts
      const activePrompts = await sqlConnection`
            SELECT 
              prompt_version_id,
              category,
              block_type,
              prompt_scope,
              version_number,
              version_name,
              prompt_text,
              time_created
            FROM "prompt_versions"
            WHERE is_active = true
            ORDER BY category, block_type;
          `;

      response.body = JSON.stringify(activePrompts);
    } catch (err) {
      console.error("Error fetching active prompts:", err);
      handleError(err, response);
    }
  },
  "POST /admin/prompt/activate": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      if (!event.body) throw new Error("Request body is missing");

      const { prompt_version_id } = parseBody(event.body);

      if (!prompt_version_id)
        throw new Error("Missing required field: prompt_version_id");

      // Get the category, block_type, and prompt_scope of the prompt to activate
      const promptToActivate = await sqlConnection`
            SELECT category, block_type, prompt_scope
            FROM "prompt_versions"
            WHERE prompt_version_id = ${prompt_version_id};
          `;

      if (promptToActivate.length === 0) {
        throw new Error("Prompt version not found");
      }

      const { category, block_type, prompt_scope } = promptToActivate[0];

      // Begin transaction: deactivate current active prompt and activate new one
      await sqlConnection.begin(async (sql) => {
        // Deactivate any currently active prompt for this category/scope slot
        if (prompt_scope === 'full_case') {
          await sql`
                UPDATE "prompt_versions"
                SET is_active = false
                WHERE category = ${category}
                  AND prompt_scope = 'full_case'
                  AND is_active = true;
              `;
        } else {
          await sql`
                UPDATE "prompt_versions"
                SET is_active = false
                WHERE category = ${category}
                  AND block_type = ${block_type}
                  AND prompt_scope = 'block'
                  AND is_active = true;
              `;
        }

        // Activate the selected prompt
        await sql`
              UPDATE "prompt_versions"
              SET is_active = true
              WHERE prompt_version_id = ${prompt_version_id};
            `;
      });

      await recordAudit(sqlConnection, {
        actorId: env.user_id,
        actorEmail: env.user?.email,
        action: "prompt.activate",
        subjectType: "prompt_version",
        subjectId: prompt_version_id,
        after: { category, block_type, prompt_scope, is_active: true },
      });

      response.body = JSON.stringify({
        message: "Prompt activated successfully",
        category,
        block_type,
        prompt_scope,
      });
    } catch (err) {
      console.error("Error activating prompt:", err);
      handleError(err, response);
    }
  },
  "DELETE /admin/prompt": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      if (
        !event.queryStringParameters ||
        !event.queryStringParameters.prompt_version_id
      ) {
        throw new Error("Missing required query parameter: prompt_version_id");
      }

      const prompt_version_id = event.queryStringParameters.prompt_version_id;

      // Get the prompt to verify it exists and check if it's active
      const promptToDelete = await sqlConnection`
            SELECT category, block_type, is_active
            FROM "prompt_versions"
            WHERE prompt_version_id = ${prompt_version_id};
          `;

      if (promptToDelete.length === 0) {
        response.statusCode = 404;
        throw new Error("Prompt version not found");
      }

      const { category, block_type, is_active } = promptToDelete[0];

      // Prevent deletion of active prompts
      if (is_active) {
        response.statusCode = 400;
        throw new Error(
          "Cannot delete an active prompt. Please deactivate it first.",
        );
      }

      // Delete the prompt
      await sqlConnection`
            DELETE FROM "prompt_versions"
            WHERE prompt_version_id = ${prompt_version_id};
          `;

      response.body = JSON.stringify({
        message: "Prompt deleted successfully",
        category,
        block_type,
      });
    } catch (err) {
      console.error("Error deleting prompt:", err);
      handleError(err, response);
    }
  },
  "GET /admin/ai_config": async (event, env) => {
    const { response } = env;
    try {
      const { SSMClient, GetParameterCommand } =
        await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient();

      const [
        llmRes,
        modelOptionsRes,
        tempRes,
        topPRes,
        maxTokensRes,
        msgLimitRes,
        fileSizeRes,
        caseTypesRes,
      ] =
        await Promise.all([
          ssm.send(new GetParameterCommand({ Name: BEDROCK_LLM_PARAM })),
          BEDROCK_MODEL_OPTIONS_PARAM
            ? ssm
                .send(new GetParameterCommand({ Name: BEDROCK_MODEL_OPTIONS_PARAM }))
                .catch(() => null)
            : Promise.resolve(null),
          ssm.send(new GetParameterCommand({ Name: BEDROCK_TEMP_PARAM })),
          ssm.send(new GetParameterCommand({ Name: BEDROCK_TOP_P_PARAM })),
          ssm.send(new GetParameterCommand({ Name: BEDROCK_MAX_TOKENS_PARAM })),
          ssm.send(new GetParameterCommand({ Name: MESSAGE_LIMIT })),
          ssm.send(new GetParameterCommand({ Name: FILE_SIZE_LIMIT })),
          CASE_TYPES_PARAM
            ? ssm
                .send(new GetParameterCommand({ Name: CASE_TYPES_PARAM }))
                .catch(() => null)
            : Promise.resolve(null),
        ]);

      const modelOptions = parseModelOptions(
        modelOptionsRes?.Parameter?.Value,
      );

      response.statusCode = 200;
      response.body = JSON.stringify({
        bedrock_llm_id: llmRes.Parameter.Value,
        model_options: modelOptions,
        temperature: tempRes.Parameter.Value,
        top_p: topPRes.Parameter.Value,
        max_tokens: maxTokensRes.Parameter.Value,
        message_limit: msgLimitRes.Parameter.Value,
        file_size_limit: fileSizeRes.Parameter.Value,
        case_types: parseCaseTypes(caseTypesRes?.Parameter?.Value),
      });
    } catch (err) {
      console.error("Failed to fetch AI config:", err);
      handleError(err, response);
    }
  },
  "POST /admin/ai_config": async (event, env) => {
    const { response } = env;
    try {
      const { SSMClient, PutParameterCommand, GetParameterCommand } =
        await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient();
      const body = parseBody(event.body);

      const modelOptionsRes = BEDROCK_MODEL_OPTIONS_PARAM
        ? await ssm
            .send(
              new GetParameterCommand({
                Name: BEDROCK_MODEL_OPTIONS_PARAM,
              }),
            )
            .catch(() => null)
        : null;

      const modelOptions = parseModelOptions(modelOptionsRes?.Parameter?.Value);
      const allowedModelIds = new Set(modelOptions.map((option) => option.value));

      const llmRes = await ssm.send(
        new GetParameterCommand({ Name: BEDROCK_LLM_PARAM }),
      );
      const tempRes = await ssm.send(
        new GetParameterCommand({ Name: BEDROCK_TEMP_PARAM }),
      );
      const topPRes = await ssm.send(
        new GetParameterCommand({ Name: BEDROCK_TOP_P_PARAM }),
      );
      const maxTokensRes = await ssm.send(
        new GetParameterCommand({ Name: BEDROCK_MAX_TOKENS_PARAM }),
      );

      const selectedModelId = body.bedrock_llm_id
        ? String(body.bedrock_llm_id)
        : llmRes.Parameter.Value;

      if (!allowedModelIds.has(selectedModelId)) {
        response.statusCode = 400;
        response.body = JSON.stringify({
          error:
            "Invalid bedrock_llm_id. Value must match one of the configured model options.",
          allowed_model_ids: [...allowedModelIds],
        });
        return;
      }

      const effectiveConfig = {
        temperature:
          body.temperature !== undefined
            ? Number(body.temperature)
            : Number(tempRes.Parameter.Value),
        top_p:
          body.top_p !== undefined
            ? Number(body.top_p)
            : Number(topPRes.Parameter.Value),
        max_tokens:
          body.max_tokens !== undefined
            ? Number(body.max_tokens)
            : Number(maxTokensRes.Parameter.Value),
      };

      const constraintCheck = validateConfigAgainstModelConstraints(
        selectedModelId,
        effectiveConfig,
        modelOptions,
      );

      if (!constraintCheck.valid) {
        response.statusCode = 400;
        response.body = JSON.stringify({
          error: "Configuration values exceed model limits for selected model",
          validation_errors: constraintCheck.errors,
          model_constraints: constraintCheck.constraints,
        });
        return;
      }

      if (body.message_limit !== undefined) {
        const messageLimitCheck = validateMessageLimit(body.message_limit);
        if (!messageLimitCheck.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: messageLimitCheck.error });
          return;
        }
      }

      if (body.file_size_limit !== undefined) {
        const fileSizeLimitCheck = validateFileSizeLimit(body.file_size_limit);
        if (!fileSizeLimitCheck.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: fileSizeLimitCheck.error });
          return;
        }
      }

      const promises = [];
      if (body.bedrock_llm_id) {
        promises.push(
          ssm.send(
            new PutParameterCommand({
              Name: BEDROCK_LLM_PARAM,
              Value: String(body.bedrock_llm_id),
              Overwrite: true,
              Type: "String",
            }),
          ),
        );
      }
      if (body.temperature !== undefined) {
        promises.push(
          ssm.send(
            new PutParameterCommand({
              Name: BEDROCK_TEMP_PARAM,
              Value: String(body.temperature),
              Overwrite: true,
              Type: "String",
            }),
          ),
        );
      }
      if (body.top_p !== undefined) {
        promises.push(
          ssm.send(
            new PutParameterCommand({
              Name: BEDROCK_TOP_P_PARAM,
              Value: String(body.top_p),
              Overwrite: true,
              Type: "String",
            }),
          ),
        );
      }
      if (body.max_tokens !== undefined) {
        promises.push(
          ssm.send(
            new PutParameterCommand({
              Name: BEDROCK_MAX_TOKENS_PARAM,
              Value: String(body.max_tokens),
              Overwrite: true,
              Type: "String",
            }),
          ),
        );
      }
      if (body.message_limit !== undefined) {
        promises.push(
          ssm.send(
            new PutParameterCommand({
              Name: MESSAGE_LIMIT,
              Value: String(body.message_limit),
              Overwrite: true,
              Type: "String",
            }),
          ),
        );
      }
      if (body.file_size_limit !== undefined) {
        promises.push(
          ssm.send(
            new PutParameterCommand({
              Name: FILE_SIZE_LIMIT,
              Value: String(body.file_size_limit),
              Overwrite: true,
              Type: "String",
            }),
          ),
        );
      }
      if (body.case_types !== undefined) {
        if (!isValidCaseTypesPayload(body.case_types)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error:
              "Invalid case_types. Provide a non-empty array of unique, non-empty strings.",
          });
          return;
        }

        const cleanedCaseTypes = body.case_types.map((caseType) =>
          String(caseType).trim(),
        );

        if (!CASE_TYPES_PARAM) {
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "CASE_TYPES_PARAM is not configured",
          });
          return;
        }

        promises.push(
          ssm.send(
            new PutParameterCommand({
              Name: CASE_TYPES_PARAM,
              Value: JSON.stringify(cleanedCaseTypes),
              Overwrite: true,
              Type: "String",
            }),
          ),
        );
      }

      await Promise.all(promises);

      await recordAudit(env.sqlConnection, {
        actorId: env.user_id,
        actorEmail: env.user?.email,
        action: "ai_config.update",
        subjectType: "bedrock_config",
        before: {
          bedrock_llm_id: llmRes.Parameter.Value,
          temperature: Number(tempRes.Parameter.Value),
          top_p: Number(topPRes.Parameter.Value),
          max_tokens: Number(maxTokensRes.Parameter.Value),
        },
        after: {
          bedrock_llm_id: selectedModelId,
          temperature: effectiveConfig.temperature,
          top_p: effectiveConfig.top_p,
          max_tokens: effectiveConfig.max_tokens,
          ...(body.message_limit !== undefined && {
            message_limit: Number(body.message_limit),
          }),
          ...(body.file_size_limit !== undefined && {
            file_size_limit: Number(body.file_size_limit),
          }),
          ...(body.case_types !== undefined && { case_types: body.case_types }),
        },
      });

      response.statusCode = 200;
      response.body = JSON.stringify({ success: true });
    } catch (err) {
      console.error("Failed to update AI config:", err);
      handleError(err, response);
    }
  },
  "GET /admin/model_options": async (event, env) => {
    const { response } = env;
    try {
      const { SSMClient, GetParameterCommand } =
        await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient();

      const modelOptionsRes = BEDROCK_MODEL_OPTIONS_PARAM
        ? await ssm
            .send(new GetParameterCommand({ Name: BEDROCK_MODEL_OPTIONS_PARAM }))
            .catch(() => null)
        : null;

      response.statusCode = 200;
      response.body = JSON.stringify({
        model_options: parseModelOptions(modelOptionsRes?.Parameter?.Value),
      });
    } catch (err) {
      console.error("Failed to fetch model options:", err);
      handleError(err, response);
    }
  },
  "GET /admin/file_size_limit": async (event, env) => {
    const { response } = env;
    try {
      const { SSMClient, GetParameterCommand } =
        await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient();

      const result = await ssm.send(
        new GetParameterCommand({ Name: process.env.FILE_SIZE_LIMIT }),
      );

      response.statusCode = 200;
      response.body = JSON.stringify({ value: result.Parameter.Value });
    } catch (err) {
      console.error("Failed to fetch file size limit:", err);
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  },
  "POST /admin/file_size_limit": async (event, env) => {
    const { response } = env;
    try {
      const { SSMClient, PutParameterCommand } =
        await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient();

      const body = parseBody(event.body);
      const newValue = body?.value;

      if (newValue === undefined || newValue === null) {
        response.statusCode = 400;
        response.body = JSON.stringify({
          error: "Missing 'value' in request body",
        });
        return;
      }

      const fileSizeLimitCheck = validateFileSizeLimit(newValue);
      if (!fileSizeLimitCheck.valid) {
        response.statusCode = 400;
        response.body = JSON.stringify({ error: fileSizeLimitCheck.error });
        return;
      }

      await ssm.send(
        new PutParameterCommand({
          Name: process.env.FILE_SIZE_LIMIT,
          Value: String(newValue),
          Overwrite: true,
          Type: "String",
        }),
      );

      response.statusCode = 200;
      response.body = JSON.stringify({ success: true, value: newValue });
    } catch (err) {
      console.error("Failed to update file size limit:", err);
      handleError(err, response);
    }
  },
  "GET /student/file_size_limit": async (event, env) => {
    const { response } = env;
    try {
      const { SSMClient, GetParameterCommand } =
        await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient();

      const result = await ssm.send(
        new GetParameterCommand({ Name: process.env.FILE_SIZE_LIMIT }),
      );

      response.statusCode = 200;
      response.body = JSON.stringify({ value: result.Parameter.Value });
    } catch (err) {
      console.error("Failed to fetch file size limit:", err);
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  },
  "GET /admin/instructorStudents": async (event, env) => {
    const { response, sqlConnection } = env;
    if (
      event.queryStringParameters != null &&
      event.queryStringParameters.instructor_id
    ) {
      const { instructor_id } = event.queryStringParameters;

      // SQL query to fetch all students for a given instructor
      const student_ids = await sqlConnection`
              SELECT u.user_id, u.first_name, u.last_name, u.user_email
  FROM instructor_students AS ist
  JOIN users AS u
  ON ist.student_id = u.user_id
  WHERE ist.instructor_id = ${instructor_id};
            `;

      response.body = JSON.stringify(student_ids);
    } else {
      response.statusCode = 400;
      response.body = JSON.stringify({
        error: "instructor_email is required",
      });
    }
  },
  "POST /admin/disclaimer": async (event, env) => {
    const { response, user_id, sqlConnection } = env;
    try {
      console.log("Disclaimer creation initiated");

      if (!event.body) throw new Error("Request body is missing");

      const { disclaimer_text, version_name } = parseBody(event.body);
      // Authorship is derived from the authenticated caller, not the request body.
      const disclaimerAuthorId = user_id;

      if (!disclaimer_text)
        throw new Error("Missing 'disclaimer_text' in request body");

      // Get the next version number
      const versionCheck = await sqlConnection`
            SELECT COALESCE(MAX(version_number), 0) + 1 as next_version
            FROM "disclaimers";
          `;

      const nextVersion = versionCheck[0].next_version;

      // Insert new disclaimer with versioning
      const insertResult = await sqlConnection`
            INSERT INTO "disclaimers" (disclaimer_text, version_number, version_name, author_id, is_active)
            VALUES (${disclaimer_text}, ${nextVersion}, ${version_name || null}, ${disclaimerAuthorId || null}, false)
            RETURNING *;
          `;

      await recordAudit(sqlConnection, {
        actorId: user_id,
        actorEmail: env.user?.email,
        action: "disclaimer.create",
        subjectType: "disclaimer",
        subjectId: insertResult[0].disclaimer_id,
        after: {
          version_number: nextVersion,
          version_name: version_name || null,
        },
      });

      response.body = JSON.stringify(insertResult[0]);
    } catch (err) {
      console.error("Error inserting disclaimer:", err);
      handleError(err, response);
    }
  },
  "GET /admin/disclaimer": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      // Fetch ALL disclaimers with author info, ordered by version
      const result = await sqlConnection`
            SELECT 
              d.disclaimer_id,
              d.disclaimer_text,
              d.version_number,
              d.version_name,
              d.author_id,
              d.time_created,
              d.last_updated,
              d.is_active,
              NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS author_name
            FROM "disclaimers" d
            LEFT JOIN "users" u ON d.author_id = u.user_id
            ORDER BY d.version_number DESC;
          `;
      response.body = JSON.stringify(result);
    } catch (err) {
      console.error("Error fetching disclaimers:", err);
      handleError(err, response);
    }
  },
  "PUT /admin/disclaimer": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      console.log("Disclaimer version update initiated");

      if (!event.body) throw new Error("Request body is missing");

      const { disclaimer_id, disclaimer_text, version_name } = parseBody(
        event.body,
      );

      if (!disclaimer_id)
        throw new Error("Missing required field: disclaimer_id");

      if (!disclaimer_text && !version_name)
        throw new Error(
          "At least one field to update is required: disclaimer_text or version_name",
        );

      // Check if disclaimer exists
      const existingDisclaimer = await sqlConnection`
            SELECT disclaimer_id FROM "disclaimers"
            WHERE disclaimer_id = ${disclaimer_id};
          `;

      if (existingDisclaimer.length === 0) {
        response.statusCode = 404;
        throw new Error("Disclaimer version not found");
      }

      // Update the disclaimer
      const updateResult = await sqlConnection`
            UPDATE "disclaimers"
            SET 
              disclaimer_text = COALESCE(${disclaimer_text || null}, disclaimer_text),
              version_name = COALESCE(${version_name || null}, version_name),
              last_updated = now()
            WHERE disclaimer_id = ${disclaimer_id}
            RETURNING *;
          `;

      response.body = JSON.stringify(updateResult[0]);
    } catch (err) {
      console.error("Error updating disclaimer:", err);
      handleError(err, response);
    }
  },
  "DELETE /admin/disclaimer": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      if (
        !event.queryStringParameters ||
        !event.queryStringParameters.disclaimer_id
      ) {
        throw new Error("Missing required query parameter: disclaimer_id");
      }

      const disclaimer_id = event.queryStringParameters.disclaimer_id;

      // Get the disclaimer to verify it exists and check if it's active
      const disclaimerToDelete = await sqlConnection`
            SELECT is_active
            FROM "disclaimers"
            WHERE disclaimer_id = ${disclaimer_id};
          `;

      if (disclaimerToDelete.length === 0) {
        response.statusCode = 404;
        throw new Error("Disclaimer version not found");
      }

      const { is_active } = disclaimerToDelete[0];

      // Prevent deletion of active disclaimer
      if (is_active) {
        response.statusCode = 400;
        throw new Error(
          "Cannot delete an active disclaimer. Please activate another first.",
        );
      }

      // Delete the disclaimer
      await sqlConnection`
            DELETE FROM "disclaimers"
            WHERE disclaimer_id = ${disclaimer_id};
          `;

      response.body = JSON.stringify({
        message: "Disclaimer deleted successfully",
      });
    } catch (err) {
      console.error("Error deleting disclaimer:", err);
      handleError(err, response);
    }
  },
  "POST /admin/disclaimer/activate": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      if (!event.body) throw new Error("Request body is missing");

      const { disclaimer_id } = parseBody(event.body);

      if (!disclaimer_id)
        throw new Error("Missing required field: disclaimer_id");

      // Check if disclaimer exists
      const disclaimerToActivate = await sqlConnection`
            SELECT disclaimer_id
            FROM "disclaimers"
            WHERE disclaimer_id = ${disclaimer_id};
          `;

      if (disclaimerToActivate.length === 0) {
        throw new Error("Disclaimer version not found");
      }

      // Begin transaction: deactivate current active disclaimer and activate new one
      await sqlConnection.begin(async (sql) => {
        // Deactivate any currently active disclaimer
        await sql`
              UPDATE "disclaimers"
              SET is_active = false
              WHERE is_active = true;
            `;

        // Activate the selected disclaimer
        await sql`
              UPDATE "disclaimers"
              SET is_active = true
              WHERE disclaimer_id = ${disclaimer_id};
            `;
      });

      await recordAudit(sqlConnection, {
        actorId: env.user_id,
        actorEmail: env.user?.email,
        action: "disclaimer.activate",
        subjectType: "disclaimer",
        subjectId: disclaimer_id,
        after: { is_active: true },
      });

      response.body = JSON.stringify({
        message: "Disclaimer activated successfully",
      });
    } catch (err) {
      console.error("Error activating disclaimer:", err);
      handleError(err, response);
    }
  },
  "POST /admin/elevate_instructor": async (event, env) => {
    const { response, sqlConnection } = env;
    if (
      event.queryStringParameters != null &&
      event.queryStringParameters.email
    ) {
      const instructorEmail = event.queryStringParameters.email;

      try {
        // Check if the user exists in database
        const existingUser = await sqlConnection`
              SELECT * FROM "users"
              WHERE user_email = ${instructorEmail};
            `;

        if (existingUser.length === 0) {
          // User does not exist in database - return error
          response.statusCode = 404;
          response.body = JSON.stringify({
            error:
              "User not found. Only existing users can be elevated to instructor.",
          });
          return;
        }

        const userRoles = existingUser[0].roles;

        // Check if the user is already an instructor or admin
        if (userRoles.includes("instructor") || userRoles.includes("admin")) {
          response.statusCode = 200;
          response.body = JSON.stringify({
            message: "This user already has instructor permissions.",
            alreadyInstructor: true,
          });
          return;
        }

        // User is a student - elevate to instructor in database only
        const newRoles = userRoles.map((role) =>
          role === "student" ? "instructor" : role,
        );

        await sqlConnection`
              UPDATE "users"
              SET roles = ${newRoles}
              WHERE user_email = ${instructorEmail};
            `;

        await recordAudit(sqlConnection, {
          actorId: env.user_id,
          actorEmail: env.user?.email,
          action: "user_role.elevate_instructor",
          subjectType: "user",
          subjectId: existingUser[0].user_id,
          subjectEmail: instructorEmail,
          before: { roles: userRoles },
          after: { roles: newRoles },
        });

        response.statusCode = 200;
        response.body = JSON.stringify({
          message: "User successfully elevated to instructor.",
          success: true,
        });
      } catch (err) {
        response.statusCode = 500;
        console.error(err);
        response.body = JSON.stringify({ error: "Internal server error" });
      }
    } else {
      response.statusCode = 400;
      response.body = JSON.stringify({ error: "Email is required" });
    }
  },
  "POST /admin/lower_instructor": async (event, env) => {
    const { response, sqlConnection } = env;
    if (
      event.queryStringParameters != null &&
      event.queryStringParameters.user_id
    ) {
      try {
        const user_id = event.queryStringParameters.user_id;

        // Fetch the roles for the user
        const userRoleData = await sqlConnection`
                    SELECT roles, user_id
                    FROM "users"
                    WHERE user_id = ${user_id};
                  `;

        const userRoles = userRoleData[0]?.roles;

        if (!userRoles || !userRoles.includes("instructor")) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "User is not an instructor or doesn't exist",
          });
          return;
        }

        // Replace 'instructor' with 'student'
        const updatedRoles = userRoles
          .filter((role) => role !== "instructor")
          .concat("student");

        // Update the roles in the database
        await sqlConnection`
                    UPDATE "users"
                    SET roles = ${updatedRoles}
                    WHERE user_id = ${user_id};
                  `;

        // Remove from instructor_students table
        await sqlConnection`
      DELETE FROM "instructor_students"
      WHERE instructor_id = ${user_id};
    `;

        await recordAudit(sqlConnection, {
          actorId: env.user_id,
          actorEmail: env.user?.email,
          action: "user_role.lower_instructor",
          subjectType: "user",
          subjectId: user_id,
          before: { roles: userRoles },
          after: { roles: updatedRoles },
        });

        response.statusCode = 200;
        response.body = JSON.stringify({
          message: `User role updated to student for ${user_id} and all instructor assigned deleted.`,
        });
      } catch (err) {
        console.log(err);
        response.statusCode = 500;
        response.body = JSON.stringify({ error: "Internal server error" });
      }
    } else {
      response.statusCode = 400;
      response.body = JSON.stringify({
        error: "email query parameter is missing",
      });
    }
  },
  "DELETE /admin/delete_instructor_student_assignment": async (event, env) => {
    const { response, sqlConnection } = env;
    if (
      event.queryStringParameters != null &&
      event.queryStringParameters.instructor_id &&
      event.queryStringParameters.student_id
    ) {
      try {
        const instructor_id = event.queryStringParameters.instructor_id;
        const student_id = event.queryStringParameters.student_id;

        // Fetch the roles for the instructor
        const userRoleData = await sqlConnection`
                SELECT roles, user_id
                FROM "users"
                WHERE user_id = ${instructor_id};
              `;

        const userRoles = userRoleData[0]?.roles;

        if (!userRoles || !userRoles.includes("instructor")) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "User is not an instructor or doesn't exist",
          });
          return;
        }

        // Step 1: Check if the relationship between the instructor and student exists
        const assignmentCheck = await sqlConnection`
                SELECT * FROM "instructor_students"
                WHERE instructor_id = ${instructor_id} AND student_id = ${student_id};
              `;

        if (assignmentCheck.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({
            error: "Instructor-student assignment not found",
          });
          return;
        }

        // Step 2: Unassign the instructor from the student
        await sqlConnection`
                DELETE FROM "instructor_students"
                WHERE instructor_id = ${instructor_id} AND student_id = ${student_id};
              `;

        await recordAudit(sqlConnection, {
          actorId: env.user_id,
          actorEmail: env.user?.email,
          action: "instructor_student.unassign",
          subjectType: "user",
          subjectId: student_id,
          after: { instructor_id, student_id },
        });

        response.statusCode = 200;
        response.body = JSON.stringify({
          message: `Instructor ${instructor_id} successfully unassigned from student ${student_id}.`,
        });
      } catch (err) {
        console.log(err);
        response.statusCode = 500;
        response.body = JSON.stringify({ error: "Internal server error" });
      }
    } else {
      response.statusCode = 400;
      response.body = JSON.stringify({
        error: "Instructor ID and Student ID query parameters are required",
      });
    }
  },
  "GET /admin/message_limit": async (event, env) => {
    const { response } = env;
    console.log("Fetching message limit");
    try {
      const ssmClient = new SSMClient();
      const command = new GetParameterCommand({
        Name: MESSAGE_LIMIT,
      });
      const result = await ssmClient.send(command);
      response.body = JSON.stringify({ value: result.Parameter.Value });
    } catch (error) {
      console.error("Error fetching message limit:", error);
      response.statusCode = 500;
      response.body = JSON.stringify({
        error: "Failed to fetch message limit",
      });
    }
  },
  "PUT /admin/message_limit": async (event, env) => {
    const { response } = env;
    console.log("Updating message limit");
    if (event.body) {
      try {
        const { limit } = JSON.parse(event.body);
        if (limit === undefined) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Limit value is required",
          });
          return;
        }

        const messageLimitCheck = validateMessageLimit(limit);
        if (!messageLimitCheck.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: messageLimitCheck.error });
          return;
        }

        const ssmClient = new SSMClient();
        const command = new PutParameterCommand({
          Name: MESSAGE_LIMIT,
          Value: String(limit),
          Type: "String",
          Overwrite: true,
        });
        await ssmClient.send(command);
        response.body = JSON.stringify({
          message: "Message limit updated successfully",
        });
      } catch (error) {
        console.error("Error updating message limit:", error);
        response.statusCode = 500;
        response.body = JSON.stringify({
          error: "Failed to update message limit",
        });
      }
    } else {
      response.statusCode = 400;
      response.body = JSON.stringify({ error: "Request body is missing" });
    }
  },
  "PUT /admin/role_labels": async (event, env) => {
    const { response, user_id, sqlConnection } = env;
    if (!event.body) {
      response.statusCode = 400;
      response.body = JSON.stringify({ error: "Request body is missing" });
      return;
    }
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      response.statusCode = 400;
      response.body = JSON.stringify({ error: "Invalid JSON body" });
      return;
    }
    const validKeys = ["student", "instructor", "admin"];
    for (const key of validKeys) {
      const entry = body[key];
      if (
        !entry ||
        typeof entry.singular !== "string" ||
        typeof entry.plural !== "string" ||
        entry.singular.trim() === "" ||
        entry.plural.trim() === "" ||
        entry.singular.length > 64 ||
        entry.plural.length > 64
      ) {
        response.statusCode = 400;
        response.body = JSON.stringify({
          error: `Invalid or missing labels for role: ${key}`,
        });
        return;
      }
    }
    try {
      for (const key of validKeys) {
        const { singular, plural } = body[key];
        await sqlConnection`
          INSERT INTO role_labels (role_key, singular_label, plural_label, updated_by, updated_at)
          VALUES (${key}, ${singular.trim()}, ${plural.trim()}, ${user_id}, now())
          ON CONFLICT (role_key) DO UPDATE
            SET singular_label = EXCLUDED.singular_label,
                plural_label   = EXCLUDED.plural_label,
                updated_by     = EXCLUDED.updated_by,
                updated_at     = now()
        `;
      }
      response.statusCode = 200;
      response.body = JSON.stringify({ message: "Role labels updated successfully" });
    } catch (err) {
      console.error("Error updating role labels:", err);
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Failed to update role labels" });
    }
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Signup Whitelist Routes
  // ──────────────────────────────────────────────────────────────────────────

  /** GET /admin/signup_mode — returns the current signup mode from SSM */
  "GET /admin/signup_mode": async (event, env) => {
    const { response } = env;
    try {
      const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient();
      const result = await ssm.send(
        new GetParameterCommand({ Name: process.env.SIGNUP_MODE_SSM_PARAM }),
      );
      response.statusCode = 200;
      response.body = JSON.stringify({ mode: result.Parameter.Value || "public" });
    } catch (err) {
      console.error("Failed to get signup mode:", err);
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  },

  /** PUT /admin/signup_mode — sets the signup mode in SSM */
  "PUT /admin/signup_mode": async (event, env) => {
    const { response } = env;
    try {
      const body = parseBody(event.body);
      const { mode } = body || {};
      if (mode !== "public" && mode !== "whitelist") {
        response.statusCode = 400;
        response.body = JSON.stringify({ error: "mode must be 'public' or 'whitelist'" });
        return;
      }
      const { SSMClient, PutParameterCommand } = await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient();
      let previousMode = null;
      try {
        const current = await ssm.send(
          new GetParameterCommand({ Name: process.env.SIGNUP_MODE_SSM_PARAM }),
        );
        previousMode = current.Parameter?.Value ?? null;
      } catch {
        previousMode = null;
      }

      await ssm.send(
        new PutParameterCommand({
          Name: process.env.SIGNUP_MODE_SSM_PARAM,
          Value: mode,
          Overwrite: true,
          Type: "String",
        }),
      );

      await recordAudit(env.sqlConnection, {
        actorId: env.user_id,
        actorEmail: env.user?.email,
        action: "signup_mode.update",
        subjectType: "signup_mode",
        before: previousMode === null ? null : { mode: previousMode },
        after: { mode },
      });

      response.statusCode = 200;
      response.body = JSON.stringify({ mode });
    } catch (err) {
      console.error("Failed to set signup mode:", err);
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  },

  /** GET /admin/whitelist — scans and returns all whitelist entries */
  "GET /admin/whitelist": async (event, env) => {
    const { response } = env;
    try {
      const { DynamoDBClient, ScanCommand } = await import("@aws-sdk/client-dynamodb");
      const dynamo = new DynamoDBClient();
      const items = [];
      let lastKey = undefined;

      do {
        const result = await dynamo.send(
          new ScanCommand({
            TableName: process.env.WHITELIST_TABLE_NAME,
            ...(lastKey && { ExclusiveStartKey: lastKey }),
          }),
        );
        for (const item of result.Items || []) {
          items.push({
            email: item.email?.S,
            canonical_role: item.canonical_role?.S,
            uploaded_label: item.uploaded_label?.S,
          });
        }
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);

      response.statusCode = 200;
      response.body = JSON.stringify({ entries: items, count: items.length });
    } catch (err) {
      console.error("Failed to scan whitelist:", err);
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  },

  /** GET /admin/whitelist/upload — returns presigned S3 PUT URL for CSV upload */
  "GET /admin/whitelist/upload": async (event, env) => {
    const { response } = env;
    try {
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

      const s3 = new S3Client();
      const bucketName = process.env.WHITELIST_UPLOAD_BUCKET;
      const key = `whitelist-${Date.now()}.csv`;

      const cmd = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        ContentType: "text/csv",
      });

      const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
      response.statusCode = 200;
      response.body = JSON.stringify({
        uploadUrl: presignedUrl,
        s3Key: key,
        expiresIn: 300,
      });
    } catch (err) {
      console.error("Failed to generate presigned URL:", err);
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  },

  /**
   * POST /admin/whitelist/upload — parses CSV and upserts entries into DynamoDB.
   * Body expects: { s3Key: "<uploaded csv object key>" }
   */
  "POST /admin/whitelist/upload": async (event, env) => {
    const { response, sqlConnection } = env;
    try {
      const body = parseBody(event.body);
      const { s3Key } = body || {};

      if (typeof s3Key !== "string" || s3Key.trim().length === 0) {
        response.statusCode = 400;
        response.body = JSON.stringify({ error: "Provide 's3Key' in request body" });
        return;
      }

      // Only read objects from the key namespace this endpoint's own GET mints.
      if (!isValidWhitelistKey(s3Key)) {
        response.statusCode = 400;
        response.body = JSON.stringify({ error: "Invalid 's3Key'" });
        return;
      }

      const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client();
      const bucketName = process.env.WHITELIST_UPLOAD_BUCKET;
      const s3Response = await s3.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
        }),
      );
      const csvText = await s3Response.Body.transformToString();

      // Fetch role labels from Postgres for label -> canonical_role resolution
      const labels = await sqlConnection`
        SELECT role_key, singular_label FROM role_labels;
      `;
      // Build case-insensitive lookup: "advocate" -> "student"
      const labelToRole = {};
      for (const row of labels) {
        labelToRole[row.singular_label.toLowerCase()] = row.role_key;
      }
      // Also accept canonical names directly
      for (const key of ["student", "instructor", "admin"]) {
        labelToRole[key] = key;
      }

      const { validItems, invalidRows } = parseWhitelistCsv(csvText, labelToRole);

      // A parse that produced no valid rows must never mutate the table: this
      // whitelist mints user roles at signup, so an empty or malformed CSV
      // would otherwise silently wipe it. Leave the table and the uploaded
      // object untouched so the admin can inspect and fix the file.
      if (validItems.length === 0) {
        response.statusCode = 400;
        response.body = JSON.stringify({
          error: "No valid rows found in CSV; whitelist unchanged",
          invalid: invalidRows.length,
          invalidRows,
        });
        return;
      }

      const { DynamoDBClient, BatchWriteItemCommand, ScanCommand } = await import("@aws-sdk/client-dynamodb");
      const dynamo = new DynamoDBClient();
      const tableName = process.env.WHITELIST_TABLE_NAME;
      const CHUNK_SIZE = 25;

      // Snapshot the existing emails so we can reconcile against the new set.
      const existingEmails = [];
      let lastKey = undefined;
      do {
        const scanResult = await dynamo.send(
          new ScanCommand({
            TableName: tableName,
            ProjectionExpression: "email",
            ...(lastKey && { ExclusiveStartKey: lastKey }),
          }),
        );
        for (const item of scanResult.Items || []) {
          if (item.email?.S) existingEmails.push(item.email.S);
        }
        lastKey = scanResult.LastEvaluatedKey;
      } while (lastKey);

      const { toPut, toDelete } = computeWhitelistReconciliation(
        existingEmails,
        validItems,
      );

      // BatchWriteItem signals partial success with HTTP 200 + UnprocessedItems
      // (throttling / throughput pressure) rather than throwing. Resubmit those
      // items with exponential backoff + jitter; if any remain after the
      // retries, surface it to the caller instead of reporting success.
      const MAX_BATCH_RETRIES = 8;
      const sendBatchWithRetry = async (requests) => {
        let unprocessed = { [tableName]: requests };
        for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
          const result = await dynamo.send(
            new BatchWriteItemCommand({ RequestItems: unprocessed }),
          );
          const remaining = result.UnprocessedItems || {};
          const remainingCount = (remaining[tableName] || []).length;
          if (remainingCount === 0) return;
          if (attempt === MAX_BATCH_RETRIES) {
            throw new Error(
              `BatchWriteItem left ${remainingCount} unprocessed item(s) after ${MAX_BATCH_RETRIES} retries`,
            );
          }
          unprocessed = remaining;
          const backoff = Math.min(1000, 2 ** attempt * 50);
          const jitter = Math.floor(Math.random() * 50);
          await new Promise((r) => setTimeout(r, backoff + jitter));
        }
      };

      // Write-first: upsert all new rows before pruning any stale ones. If a
      // batch fails mid-run the table still holds the old rows plus whatever
      // new rows landed — it is never left empty.
      let processed = 0;
      try {
        for (let i = 0; i < toPut.length; i += CHUNK_SIZE) {
          const chunk = toPut.slice(i, i + CHUNK_SIZE);
          const putRequests = chunk.map((item) => ({
            PutRequest: {
              Item: {
                email: { S: item.email },
                canonical_role: { S: item.canonical_role },
                uploaded_label: { S: item.uploaded_label },
              },
            },
          }));
          await sendBatchWithRetry(putRequests);
          processed += chunk.length;
        }

        // Prune only the rows absent from the new set, after all puts succeeded.
        for (let i = 0; i < toDelete.length; i += CHUNK_SIZE) {
          const chunk = toDelete.slice(i, i + CHUNK_SIZE);
          const deleteRequests = chunk.map((email) => ({
            DeleteRequest: { Key: { email: { S: email } } },
          }));
          await sendBatchWithRetry(deleteRequests);
        }
      } catch (batchError) {
        // Partial application: do NOT delete the uploaded object or report
        // success — a revoked entry may still be live in the table. Record the
        // partial-failure state so an admin can reconcile.
        console.error("Whitelist batch write incomplete:", batchError);
        await recordAudit(env.sqlConnection, {
          actorId: env.user_id,
          actorEmail: env.user?.email,
          action: "whitelist.replace.partial_failure",
          subjectType: "signup_whitelist",
          after: {
            error: batchError.message,
            processed,
            toPut: toPut.length,
            toDelete: toDelete.length,
          },
        }).catch((auditErr) =>
          console.error("Failed to record partial-failure audit:", auditErr),
        );
        response.statusCode = 502;
        response.body = JSON.stringify({
          error:
            "Whitelist update only partially applied; table may be inconsistent. " +
            "The uploaded file was retained for inspection.",
          processed,
        });
        return;
      }

      // Clean up uploaded object after processing.
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
        }),
      );

      await recordAudit(env.sqlConnection, {
        actorId: env.user_id,
        actorEmail: env.user?.email,
        action: "whitelist.replace",
        subjectType: "signup_whitelist",
        after: { processed, invalid: invalidRows.length },
      });

      response.statusCode = 200;
      response.body = JSON.stringify({
        processed,
        invalid: invalidRows.length,
        invalidRows,
      });
    } catch (err) {
      console.error("Failed to upload whitelist:", err);
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  },

  /** DELETE /admin/whitelist — removes entry by ?email= query param */
  "DELETE /admin/whitelist": async (event, env) => {
    const { response } = env;
    try {
      const email = event.queryStringParameters?.email?.toLowerCase().trim();
      if (!email) {
        response.statusCode = 400;
        response.body = JSON.stringify({ error: "Missing 'email' query parameter" });
        return;
      }
      const { DynamoDBClient, DeleteItemCommand } = await import("@aws-sdk/client-dynamodb");
      const dynamo = new DynamoDBClient();
      await dynamo.send(
        new DeleteItemCommand({
          TableName: process.env.WHITELIST_TABLE_NAME,
          Key: { email: { S: email } },
        }),
      );

      await recordAudit(env.sqlConnection, {
        actorId: env.user_id,
        actorEmail: env.user?.email,
        action: "whitelist.remove",
        subjectType: "signup_whitelist",
        subjectEmail: email,
        before: { email },
      });

      response.statusCode = 200;
      response.body = JSON.stringify({ message: "Entry removed", email });
    } catch (err) {
      console.error("Failed to delete whitelist entry:", err);
      response.statusCode = 500;
      response.body = JSON.stringify({ error: "Internal server error" });
    }
  },

};

exports.handler = async (event, context) => {
  logger.addContext(context);
  const response = createResponse(event);

  // Initialize the database connection if not already initialized
  try {
    await initConnection();
  } catch (err) {
    console.error("Database connection failed:", err);
    response.statusCode = 500;
    response.body = JSON.stringify({
      error: "Service unavailable (DB connection)",
    });
    return response;
  }

  const sqlConnection = getSqlConnection();

  // Extract userId and user metadata from authorization context
  const userId = event.requestContext?.authorizer?.userId;
  const email = event.requestContext?.authorizer?.email;
  const firstName = event.requestContext?.authorizer?.firstName;
  const lastName = event.requestContext?.authorizer?.lastName;
  const roles = JSON.parse(event.requestContext?.authorizer?.roles || "[]");

  // Verify user has admin role
  if (!roles.includes("admin")) {
    response.statusCode = 403;
    response.body = JSON.stringify({
      error: "Forbidden: Admin access required",
    });
    return response;
  }

  const currentUser = {
    user_id: userId,
    email,
    first_name: firstName,
    last_name: lastName,
    roles,
  };

  try {
    const pathData = event.httpMethod + " " + event.resource;
    const env = {
      event,
      response,
      user: currentUser,
      user_id: userId,
      sqlConnection,
    };

    const handlerConfig = routes[pathData];
    if (handlerConfig) {
      await handlerConfig(event, env);
    } else {
      response.statusCode = 404;
      response.body = JSON.stringify({ error: "Route not found" });
    }

    logger.info("Admin Response", {
      route: pathData,
      actorId: userId,
      statusCode: response.statusCode,
    });
  } catch (error) {
    response.statusCode = 500;
    logger.error("Handler error", error);
    response.body = JSON.stringify({ error: "Internal server error" });
    logger.info("Admin Response", {
      route: event.httpMethod + " " + event.resource,
      actorId: userId,
      statusCode: response.statusCode,
    });
  }
  return response;
};
