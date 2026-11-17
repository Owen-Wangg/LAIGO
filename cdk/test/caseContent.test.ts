// Unit tests for the screening applied when a case is edited. The Bedrock call
// is replaced by an injected function.
const {
  getChangedCaseFields,
  validateCaseFieldLengths,
  buildScreeningText,
  screenCaseContent,
} = require("../lambda/handlers/utils/caseContent");

const existing = {
  case_title: "Lease dispute",
  case_type: "Housing",
  case_description: "Landlord kept the deposit.",
  jurisdiction: ["Provincial"],
  province: "Ontario",
  statute: "N/A",
};

describe("getChangedCaseFields", () => {
  test("returns nothing when every field is unchanged", () => {
    expect(getChangedCaseFields(existing, { ...existing })).toEqual({});
  });

  test("returns only the fields that differ", () => {
    const changed = getChangedCaseFields(existing, {
      ...existing,
      case_description: "New text",
      jurisdiction: ["Provincial", "Federal"],
    });
    expect(Object.keys(changed).sort()).toEqual([
      "case_description",
      "jurisdiction",
    ]);
  });
});

describe("validateCaseFieldLengths", () => {
  test("accepts values within the limits", () => {
    expect(
      validateCaseFieldLengths({
        case_title: "a".repeat(200),
        case_description: "a".repeat(4000),
        jurisdiction: ["Provincial"],
      }).valid,
    ).toBe(true);
  });

  test("rejects an over-long description", () => {
    const result = validateCaseFieldLengths({
      case_description: "a".repeat(4001),
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("case_description");
  });

  test("rejects a non-text title", () => {
    expect(validateCaseFieldLengths({ case_title: { a: 1 } }).valid).toBe(
      false,
    );
  });

  test("rejects a jurisdiction that is not a list of short strings", () => {
    expect(validateCaseFieldLengths({ jurisdiction: "Federal" }).valid).toBe(
      false,
    );
    expect(validateCaseFieldLengths({ jurisdiction: [1] }).valid).toBe(false);
    expect(
      validateCaseFieldLengths({ jurisdiction: ["a".repeat(101)] }).valid,
    ).toBe(false);
  });

  test("ignores fields that did not change", () => {
    expect(validateCaseFieldLengths({}).valid).toBe(true);
  });
});

describe("buildScreeningText", () => {
  test("joins changed fields and flattens jurisdiction", () => {
    expect(
      buildScreeningText({
        case_description: "Text",
        jurisdiction: ["A", "B"],
      }),
    ).toBe("Text A B");
  });

  test("is empty when nothing changed", () => {
    expect(buildScreeningText({})).toBe("");
  });
});

describe("screenCaseContent", () => {
  const options = (applyGuardrail: jest.Mock) => ({
    applyGuardrail,
    guardrailId: "gr-1",
    guardrailVersion: "1",
  });

  test("skips the guardrail call when there is no text", async () => {
    const apply = jest.fn();
    expect(await screenCaseContent("", options(apply))).toEqual({
      blocked: false,
    });
    expect(apply).not.toHaveBeenCalled();
  });

  test("passes the text to the guardrail as input", async () => {
    const apply = jest.fn().mockResolvedValue({ action: "NONE" });
    const result = await screenCaseContent("hello", options(apply));
    expect(result.blocked).toBe(false);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        guardrailIdentifier: "gr-1",
        guardrailVersion: "1",
        source: "INPUT",
      }),
    );
  });

  test("reports a block and asks for personal information to be removed", async () => {
    const apply = jest.fn().mockResolvedValue({
      action: "GUARDRAIL_INTERVENED",
      assessments: [{ sensitiveInformationPolicy: {} }],
    });
    const result = await screenCaseContent("text", options(apply));
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("personal information");
  });

  test("reports a generic block for other interventions", async () => {
    const apply = jest.fn().mockResolvedValue({
      action: "GUARDRAIL_INTERVENED",
      assessments: [{ contentPolicy: {} }],
    });
    const result = await screenCaseContent("text", options(apply));
    expect(result).toEqual({
      blocked: true,
      message: "Input blocked by content guardrails.",
    });
  });

  test("fails closed when the guardrail call fails", async () => {
    const apply = jest.fn().mockRejectedValue(new Error("down"));
    await expect(screenCaseContent("text", options(apply))).rejects.toThrow(
      "down",
    );
  });

  test("fails closed when the guardrail is not configured", async () => {
    const apply = jest.fn();
    await expect(
      screenCaseContent("text", {
        applyGuardrail: apply,
        guardrailId: "",
        guardrailVersion: "",
      }),
    ).rejects.toThrow("not configured");
  });
});