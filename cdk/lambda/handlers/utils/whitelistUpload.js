// Centralized, dependency-free logic for the whitelist CSV upload flow.
//
// This module holds every pure decision for POST /admin/whitelist/upload in one
// place so the behavior can be unit tested in isolation without AWS SDK calls.
// It performs no I/O: the caller supplies raw inputs and receives plain data.

// The upload key is minted exclusively by GET /admin/whitelist/upload as
// `whitelist-<timestamp>.csv`. Pin the accepted shape to that exact pattern so
// the parser can only ever read an object from that namespace: no sub-paths,
// no traversal, no other prefixes or extensions.
const WHITELIST_KEY_PATTERN = /^whitelist-\d+\.csv$/;

/**
 * Validate that an s3Key matches the exact minted whitelist object pattern.
 *
 * @param {string} s3Key
 * @returns {boolean} true only for `whitelist-<digits>.csv` with no path parts.
 */
function isValidWhitelistKey(s3Key) {
  return typeof s3Key === "string" && WHITELIST_KEY_PATTERN.test(s3Key);
}

/**
 * Parse whitelist CSV text into valid items and invalid rows.
 *
 * Each line is `email,label`. A header row whose second column is literally
 * "role" is skipped. Emails are lowercased; labels are resolved to a canonical
 * role via the supplied case-insensitive map. A row is invalid when the email
 * is missing / lacks "@" or the label does not resolve to a canonical role.
 *
 * @param {string} csvText - raw CSV contents
 * @param {Object<string,string>} labelToRole - lowercased label -> canonical role
 * @returns {{validItems: Array<{email:string, canonical_role:string, uploaded_label:string}>, invalidRows: Array<{row:number, email:string, label:string, reason:string}>}}
 */
function parseWhitelistCsv(csvText, labelToRole) {
  const map = labelToRole || {};
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const validItems = [];
  const invalidRows = [];

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const email = (parts[0] || "").trim().toLowerCase();
    const label = (parts[1] || "").trim();

    // Skip header row if the label column literally says "role".
    if (i === 0 && label.toLowerCase() === "role") continue;

    const canonicalRole = map[label.toLowerCase()];

    if (!email || !email.includes("@") || !canonicalRole) {
      invalidRows.push({
        row: i + 1,
        email,
        label,
        reason: !canonicalRole ? "unknown role label" : "invalid email",
      });
      continue;
    }

    validItems.push({
      email,
      canonical_role: canonicalRole,
      uploaded_label: label,
    });
  }

  return { validItems, invalidRows };
}

/**
 * Compute a write-first reconciliation between the existing table rows and the
 * newly parsed items. `toPut` upserts every new item; `toDelete` prunes only
 * existing emails absent from the new set. Writing puts before deletes means a
 * mid-run failure can never leave the table empty.
 *
 * @param {string[]} existingEmails - emails currently stored (already lowercased)
 * @param {Array<{email:string}>} validItems - parsed items to upsert
 * @returns {{toPut: Array, toDelete: string[]}}
 */
function computeWhitelistReconciliation(existingEmails, validItems) {
  const items = Array.isArray(validItems) ? validItems : [];
  const existing = Array.isArray(existingEmails) ? existingEmails : [];

  const newEmails = new Set(items.map((it) => String(it.email).toLowerCase()));
  const toDelete = existing.filter(
    (email) => !newEmails.has(String(email).toLowerCase()),
  );

  return { toPut: items, toDelete };
}

module.exports = {
  isValidWhitelistKey,
  parseWhitelistCsv,
  computeWhitelistReconciliation,
  WHITELIST_KEY_PATTERN,
};
