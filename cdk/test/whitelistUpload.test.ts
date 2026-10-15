// Unit tests for the pure whitelist-upload logic used by
// POST /admin/whitelist/upload. The module is plain JS (shared with the Lambda
// runtime), required directly.
const {
  isValidWhitelistKey,
  parseWhitelistCsv,
  computeWhitelistReconciliation,
} = require("../lambda/handlers/utils/whitelistUpload");

describe("isValidWhitelistKey", () => {
  test("accepts the exact minted pattern", () => {
    expect(isValidWhitelistKey("whitelist-123.csv")).toBe(true);
    expect(isValidWhitelistKey("whitelist-1700000000000.csv")).toBe(true);
  });

  test("rejects path prefixes and traversal", () => {
    expect(isValidWhitelistKey("uploads/whitelist-123.csv")).toBe(false);
    expect(isValidWhitelistKey("../whitelist-1.csv")).toBe(false);
    expect(isValidWhitelistKey("whitelist-123.csv/../secret")).toBe(false);
  });

  test("rejects other names, extensions and malformed keys", () => {
    expect(isValidWhitelistKey("foo.csv")).toBe(false);
    expect(isValidWhitelistKey("whitelist-.csv")).toBe(false);
    expect(isValidWhitelistKey("whitelist-123.txt")).toBe(false);
    expect(isValidWhitelistKey("whitelist-abc.csv")).toBe(false);
    expect(isValidWhitelistKey("")).toBe(false);
  });

  test("rejects non-string input", () => {
    expect(isValidWhitelistKey(undefined)).toBe(false);
    expect(isValidWhitelistKey(null)).toBe(false);
    expect(isValidWhitelistKey(123 as unknown as string)).toBe(false);
  });
});

describe("parseWhitelistCsv", () => {
  const labelToRole = {
    advocate: "student",
    coach: "instructor",
    student: "student",
    instructor: "instructor",
    admin: "admin",
  };

  test("skips a header row whose label column is 'role'", () => {
    const csv = "email,role\njane@example.com,advocate";
    const { validItems, invalidRows } = parseWhitelistCsv(csv, labelToRole);
    expect(invalidRows).toHaveLength(0);
    expect(validItems).toEqual([
      {
        email: "jane@example.com",
        canonical_role: "student",
        uploaded_label: "advocate",
      },
    ]);
  });

  test("resolves custom labels and canonical names case-insensitively", () => {
    const csv = "A@Example.com,Advocate\nb@example.com,INSTRUCTOR";
    const { validItems } = parseWhitelistCsv(csv, labelToRole);
    expect(validItems).toEqual([
      {
        email: "a@example.com",
        canonical_role: "student",
        uploaded_label: "Advocate",
      },
      {
        email: "b@example.com",
        canonical_role: "instructor",
        uploaded_label: "INSTRUCTOR",
      },
    ]);
  });

  test("flags invalid emails and unknown labels, and ignores blank lines", () => {
    const csv = [
      "notanemail,advocate",
      "c@example.com,wizard",
      "",
      "   ",
      "d@example.com,coach",
    ].join("\n");
    const { validItems, invalidRows } = parseWhitelistCsv(csv, labelToRole);
    expect(validItems).toEqual([
      {
        email: "d@example.com",
        canonical_role: "instructor",
        uploaded_label: "coach",
      },
    ]);
    expect(invalidRows).toEqual([
      { row: 1, email: "notanemail", label: "advocate", reason: "invalid email" },
      { row: 2, email: "c@example.com", label: "wizard", reason: "unknown role label" },
    ]);
  });

  test("returns empty results for empty input", () => {
    expect(parseWhitelistCsv("", labelToRole)).toEqual({
      validItems: [],
      invalidRows: [],
    });
  });
});

describe("computeWhitelistReconciliation", () => {
  const items = [
    { email: "a@example.com", canonical_role: "student", uploaded_label: "advocate" },
    { email: "b@example.com", canonical_role: "admin", uploaded_label: "admin" },
  ];

  test("deletes existing emails not present in the new set", () => {
    const { toPut, toDelete } = computeWhitelistReconciliation(
      ["a@example.com", "stale@example.com"],
      items,
    );
    expect(toPut).toBe(items);
    expect(toDelete).toEqual(["stale@example.com"]);
  });

  test("deletes nothing when existing is a subset of the new set", () => {
    const { toDelete } = computeWhitelistReconciliation(
      ["a@example.com"],
      items,
    );
    expect(toDelete).toEqual([]);
  });

  test("deletes everything stale when there is no overlap", () => {
    const { toDelete } = computeWhitelistReconciliation(
      ["x@example.com", "y@example.com"],
      items,
    );
    expect(toDelete).toEqual(["x@example.com", "y@example.com"]);
  });

  test("compares emails case-insensitively", () => {
    const { toDelete } = computeWhitelistReconciliation(
      ["A@Example.com"],
      items,
    );
    expect(toDelete).toEqual([]);
  });

  test("empty validItems still returns no puts and deletes nothing extra via guard caller", () => {
    const { toPut, toDelete } = computeWhitelistReconciliation(
      ["a@example.com"],
      [],
    );
    expect(toPut).toEqual([]);
    expect(toDelete).toEqual(["a@example.com"]);
  });
});
