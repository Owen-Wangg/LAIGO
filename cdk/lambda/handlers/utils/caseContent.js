"use strict";
/**
 * Validation and guardrail screening for user-editable case content.
 *
 * Case metadata is stored and later placed into AI system prompts, so edits to
 * it must meet the same screening as case creation (case_generation applies the
 * Bedrock guardrail there). Only fields the caller actually changed are
 * checked, so a case saved before these checks existed stays editable.
 */

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000; // matches the overview limit in the create-case form
const MAX_SHORT_FIELD_LENGTH = 200; // province, statute
const MAX_JURISDICTION_ITEMS = 20;
const MAX_JURISDICTION_ITEM_LENGTH = 100;

const SCREENED_FIELDS = [
  "case_title",
  "case_type",
  "case_description",
  "jurisdiction",
  "province",
  "statute",
];

function normalize(value) {
  return JSON.stringify(value ?? null);
}

/**
 * Return the screened fields whose submitted value differs from the stored one.
 *
 * @param {Object} existing - stored case row
 * @param {Object} submitted - fields from the request body
 * @returns {Object} map of field name to submitted value
 */
function getChangedCaseFields(existing, submitted) {
  const changed = {};
  for (const field of SCREENED_FIELDS) {
    if (normalize(existing?.[field]) !== normalize(submitted?.[field])) {
      changed[field] = submitted?.[field];
    }
  }
  return changed;
}

/**
 * Check type and length bounds on the changed fields.
 *
 * @param {Object} changed - output of getChangedCaseFields
 * @returns {{valid: boolean, error?: string}}
 */
function validateCaseFieldLengths(changed) {
  const isText = (v) => v === null || v === undefined || typeof v === "string";

  for (const field of [
    "case_title",
    "case_description",
    "province",
    "statute",
  ]) {
    if (field in changed && !isText(changed[field])) {
      return { valid: false, error: `${field} must be text` };
    }
  }

  const limits = [
    ["case_title", MAX_TITLE_LENGTH],
    ["case_description", MAX_DESCRIPTION_LENGTH],
    ["province", MAX_SHORT_FIELD_LENGTH],
    ["statute", MAX_SHORT_FIELD_LENGTH],
  ];
  for (const [field, max] of limits) {
    const value = changed[field];
    if (typeof value === "string" && value.length > max) {
      return {
        valid: false,
        error: `${field} is too long (max ${max} characters)`,
      };
    }
  }

  if ("jurisdiction" in changed) {
    const j = changed.jurisdiction;
    if (j !== null && j !== undefined) {
      if (
        !Array.isArray(j) ||
        j.length > MAX_JURISDICTION_ITEMS ||
        j.some(
          (item) =>
            typeof item !== "string" ||
            item.length > MAX_JURISDICTION_ITEM_LENGTH,
        )
      ) {
        return { valid: false, error: "jurisdiction is not valid" };
      }
    }
  }

  return { valid: true };
}

/**
 * Join the changed fields into the text the guardrail screens. Returns an empty
 * string when nothing that needs screening changed.
 */
function buildScreeningText(changed) {
  return SCREENED_FIELDS.filter((field) => field in changed)
    .map((field) => {
      const value = changed[field];
      if (Array.isArray(value)) return value.join(" ");
      return value == null ? "" : String(value);
    })
    .filter((text) => text.trim() !== "")
    .join(" ");
}

let client;

/**
 * Call the Bedrock ApplyGuardrail API. The SDK is loaded on first use; the
 * Lambda Node.js runtime provides it.
 */
async function applyGuardrail(params) {
  const {
    BedrockRuntimeClient,
    ApplyGuardrailCommand,
  } = require("@aws-sdk/client-bedrock-runtime");
  client = client ?? new BedrockRuntimeClient({});
  return client.send(new ApplyGuardrailCommand(params));
}

/**
 * Screen text with the Bedrock guardrail.
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {Function} [options.applyGuardrail] - override for tests
 * @param {string} [options.guardrailId]
 * @param {string} [options.guardrailVersion]
 * @returns {Promise<{blocked: boolean, message?: string}>}
 * @throws when the guardrail is not configured or cannot be called, so the
 *   caller fails closed instead of saving unscreened content.
 */
async function screenCaseContent(text, options = {}) {
  if (!text) {
    return { blocked: false };
  }
  const guardrailId = options.guardrailId ?? process.env.GUARDRAIL_ID;
  const guardrailVersion =
    options.guardrailVersion ?? process.env.GUARDRAIL_VERSION;
  if (!guardrailId || !guardrailVersion) {
    throw new Error("Guardrail is not configured");
  }

  const result = await (options.applyGuardrail ?? applyGuardrail)({
    guardrailIdentifier: guardrailId,
    guardrailVersion,
    source: "INPUT",
    content: [{ text: { text, qualifiers: ["guard_content"] } }],
  });

  if (result.action !== "GUARDRAIL_INTERVENED") {
    return { blocked: false };
  }

  const hasPii = (result.assessments ?? []).some(
    (assessment) => assessment.sensitiveInformationPolicy,
  );
  return {
    blocked: true,
    message: hasPii
      ? "Please remove personal information from the case details."
      : "Input blocked by content guardrails.",
  };
}

module.exports = {
  getChangedCaseFields,
  validateCaseFieldLengths,
  buildScreeningText,
  screenCaseContent,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
};
