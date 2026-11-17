// Verifies the audit helper records refused role changes with a denied outcome.
// The logger is mocked and the database is a tagged-template fake that keeps
// the values of each insert.
jest.mock(
  "@aws-lambda-powertools/logger",
  () => ({
    Logger: jest.fn(() => ({ error: jest.fn() })),
  }),
  { virtual: true },
);

const { recordDeniedRoleChange } = require("../lambda/handlers/utils/audit");

function createFakeConnection() {
  const inserts: unknown[][] = [];
  const sql = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    inserts.push(values);
    return [];
  };
  return { sql, inserts };
}

// Column order of the INSERT in recordAudit.
const COLUMN = {
  actorId: 0,
  actorEmail: 1,
  action: 2,
  subjectType: 3,
  subjectId: 4,
  subjectEmail: 5,
  before: 6,
  after: 7,
};

describe("recordDeniedRoleChange", () => {
  test("records the actor, target, attempted role and denied outcome", async () => {
    const { sql, inserts } = createFakeConnection();
    await recordDeniedRoleChange(sql, {
      action: "user_role.update",
      actorId: "admin-1",
      actorEmail: "admin@example.com",
      subjectId: "user-1",
      subjectEmail: "user@example.com",
      rolesBefore: ["admin", "student"],
      attempted: [{ operation: "remove", role: "admin" }],
      decision: { allowed: false, statusCode: 400, error: "Cannot remove the last remaining admin" },
    });

    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row[COLUMN.action]).toBe("user_role.update.denied");
    expect(row[COLUMN.actorId]).toBe("admin-1");
    expect(row[COLUMN.actorEmail]).toBe("admin@example.com");
    expect(row[COLUMN.subjectId]).toBe("user-1");
    expect(row[COLUMN.subjectEmail]).toBe("user@example.com");
    expect(JSON.parse(row[COLUMN.before] as string)).toEqual({
      roles: ["admin", "student"],
    });
    expect(JSON.parse(row[COLUMN.after] as string)).toEqual({
      outcome: "denied",
      reason: "Cannot remove the last remaining admin",
      statusCode: 400,
      attempted: [{ operation: "remove", role: "admin" }],
    });
  });

  test("records every change of a batch", async () => {
    const { sql, inserts } = createFakeConnection();
    await recordDeniedRoleChange(sql, {
      action: "user_role.lower_instructor",
      actorId: "admin-1",
      subjectId: "user-1",
      attempted: [
        { operation: "add", role: "student" },
        { operation: "remove", role: "instructor" },
      ],
      decision: { allowed: false, statusCode: 400, error: "User does not have this role" },
    });
    const after = JSON.parse(inserts[0][COLUMN.after] as string);
    expect(after.attempted).toHaveLength(2);
    expect(JSON.parse(inserts[0][COLUMN.before] as string)).toEqual({ roles: [] });
  });

  test("limits the length of request values it stores", async () => {
    const { sql, inserts } = createFakeConnection();
    await recordDeniedRoleChange(sql, {
      action: "user_role.update",
      attempted: [{ operation: "add", role: "x".repeat(5000) }],
      decision: { allowed: false, statusCode: 400, error: "Invalid role" },
    });
    const after = JSON.parse(inserts[0][COLUMN.after] as string);
    expect(after.attempted[0].role).toHaveLength(64);
  });

  test("does not throw when the audit write fails", async () => {
    const failing = async () => {
      throw new Error("db down");
    };
    await expect(
      recordDeniedRoleChange(failing, {
        action: "user_role.update",
        attempted: [],
        decision: { allowed: false, statusCode: 403, error: "no" },
      }),
    ).resolves.toBeUndefined();
  });
});