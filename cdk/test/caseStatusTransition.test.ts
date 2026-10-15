// Unit tests for the pure status-edit guard used by PUT /student/edit_case.
// The module is plain JS (shared with the Lambda runtime), required directly.
//
// edit_case persists case content only; it must not drive a workflow
// transition. The handler resolves `currentStatus` from the database and this
// guard decides whether the body's `requestedStatus` is acceptable: it is only
// acceptable when it is absent or equal to the current status. Any real state
// change must be rejected with 409 so it never reaches the UPDATE.
const {
  validateCaseStatusEdit,
} = require("../lambda/handlers/utils/caseStatusTransition");

const STATUSES = ["in_progress", "submitted", "reviewed", "archived"];

describe("validateCaseStatusEdit", () => {
  test.each(STATUSES)(
    "allows when requestedStatus equals currentStatus (%s)",
    (status) => {
      const result = validateCaseStatusEdit({
        currentStatus: status,
        requestedStatus: status,
      });
      expect(result.allowed).toBe(true);
      expect(result.statusCode).toBeUndefined();
    },
  );

  test("allows when requestedStatus is undefined", () => {
    const result = validateCaseStatusEdit({
      currentStatus: "in_progress",
      requestedStatus: undefined,
    });
    expect(result.allowed).toBe(true);
  });

  test("allows when requestedStatus is null", () => {
    const result = validateCaseStatusEdit({
      currentStatus: "submitted",
      requestedStatus: null,
    });
    expect(result.allowed).toBe(true);
  });

  const disallowed: Array<[string, string]> = [
    ["in_progress", "reviewed"],
    ["in_progress", "submitted"],
    ["submitted", "in_progress"],
    ["submitted", "reviewed"],
    ["reviewed", "in_progress"],
    ["in_progress", "archived"],
    ["submitted", "archived"],
    ["reviewed", "archived"],
  ];

  test.each(disallowed)(
    "rejects status change %s -> %s with 409",
    (currentStatus, requestedStatus) => {
      const result = validateCaseStatusEdit({
        currentStatus,
        requestedStatus,
      });
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(409);
      expect(result.error).toMatch(/cannot be changed through this endpoint/i);
    },
  );
});
