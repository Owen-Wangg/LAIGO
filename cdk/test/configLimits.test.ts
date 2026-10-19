// Unit tests for the pure usage-limit validators shared by POST /admin/ai_config
// and the dedicated message-limit / file-size-limit endpoints.
// The module is plain JS (shared with the Lambda runtime), required directly.
const {
  validateMessageLimit,
  validateFileSizeLimit,
} = require("../lambda/handlers/utils/configLimits");

describe("validateMessageLimit", () => {
  test.each([["Infinity"], [10], ["10"], ["500"]])(
    "accepts %p",
    (value) => {
      expect(validateMessageLimit(value).valid).toBe(true);
    },
  );

  test.each([["abc"], ["0"], [0], [9], [-5], [undefined], [""]])(
    "rejects %p",
    (value) => {
      const result = validateMessageLimit(value);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/infinity.*10|greater than or equal to 10/i);
    },
  );
});

describe("validateFileSizeLimit", () => {
  test.each([[500], ["500"], [1]])("accepts %p", (value) => {
    expect(validateFileSizeLimit(value).valid).toBe(true);
  });

  test.each([["abc"], [""], [0], [-1], [1.5], ["10abc"], [undefined]])(
    "rejects %p",
    (value) => {
      const result = validateFileSizeLimit(value);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/positive integer/i);
    },
  );
});
