// Unit tests for the guarded role-change transaction used by the admin
// role routes. The database is replaced by a tagged-template fake that records
// every statement, so the tests check which writes the policy allows. Like a
// real transaction, writes made inside begin() are kept only if the callback
// resolves and are discarded if it throws.
const {
  applyRoleChanges,
} = require("../lambda/handlers/utils/applyRoleChanges");

type Statement = { sql: string; values: unknown[] };

function createFakeConnection(rows: { roles: string[]; adminCount: number }) {
  const statements: Statement[] = [];
  let committed: Statement[] = [];
  let pending: Statement[] = [];
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ sql: text, values });
    if (/^(UPDATE|DELETE)/.test(text)) {
      pending.push({ sql: text, values });
    }
    if (text.startsWith("SELECT roles FROM")) {
      return [{ roles: rows.roles }];
    }
    if (text.includes("= ANY(roles)")) {
      return Array.from({ length: rows.adminCount }, (_, i) => ({
        user_id: `admin-${i}`,
      }));
    }
    return [];
  };
  const connection = {
    begin: async (callback: (tx: typeof sql) => Promise<void>) => {
      pending = [];
      try {
        await callback(sql);
        committed = [...committed, ...pending];
      } finally {
        pending = [];
      }
    },
  };
  // Writes that survived the transaction.
  const writes = () => committed;
  return { connection, writes, statements };
}

describe("applyRoleChanges", () => {
  const actor = "admin-actor";
  const target = "user-target";

  test("reads under row locks before writing", async () => {
    const { connection, statements } = createFakeConnection({
      roles: ["student"],
      adminCount: 2,
    });
    await applyRoleChanges(connection, {
      targetUserId: target,
      actorUserId: actor,
      changes: [{ operation: "add", role: "instructor" }],
    });
    expect(statements[0].sql).toContain("FOR UPDATE");
    expect(statements[1].sql).toContain("FOR UPDATE");
  });

  test("adding instructor keeps the existing student role", async () => {
    const { connection, writes } = createFakeConnection({
      roles: ["student"],
      adminCount: 1,
    });
    const { decision, rolesBefore } = await applyRoleChanges(connection, {
      targetUserId: target,
      actorUserId: actor,
      changes: [{ operation: "add", role: "instructor" }],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.rolesAfter).toEqual(["student", "instructor"]);
    expect(rolesBefore).toEqual(["student"]);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].sql).toContain("array_append");
  });

  test("rejects an admin changing their own admin role without writing", async () => {
    const { connection, writes } = createFakeConnection({
      roles: ["admin"],
      adminCount: 2,
    });
    const { decision } = await applyRoleChanges(connection, {
      targetUserId: actor,
      actorUserId: actor,
      changes: [{ operation: "add", role: "admin" }],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.statusCode).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  test("never removes the last admin", async () => {
    const { connection, writes } = createFakeConnection({
      roles: ["admin", "student"],
      adminCount: 1,
    });
    const { decision } = await applyRoleChanges(connection, {
      targetUserId: target,
      actorUserId: actor,
      changes: [{ operation: "remove", role: "admin" }],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.error).toBe("Cannot remove the last remaining admin");
    expect(writes()).toHaveLength(0);
  });

  test("replacing instructor with student also clears instructor assignments", async () => {
    const { connection, writes } = createFakeConnection({
      roles: ["instructor"],
      adminCount: 1,
    });
    const { decision } = await applyRoleChanges(connection, {
      targetUserId: target,
      actorUserId: actor,
      changes: [
        { operation: "add", role: "student" },
        { operation: "remove", role: "instructor" },
      ],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.rolesAfter).toEqual(["student"]);
    const statementsWritten = writes().map((s) => s.sql);
    expect(statementsWritten.some((s) => s.includes("array_append"))).toBe(
      true,
    );
    expect(statementsWritten.some((s) => s.includes("array_remove"))).toBe(
      true,
    );
    expect(
      statementsWritten.some((s) => s.includes("instructor_students")),
    ).toBe(true);
  });

  test("stops at the first rejected change and writes nothing after it", async () => {
    const { connection, writes } = createFakeConnection({
      roles: ["student"],
      adminCount: 1,
    });
    const { decision } = await applyRoleChanges(connection, {
      targetUserId: target,
      actorUserId: actor,
      changes: [
        { operation: "remove", role: "instructor" },
        { operation: "add", role: "student" },
      ],
    });
    expect(decision.allowed).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  test("rolls back earlier writes when a later change is rejected", async () => {
    const { connection, writes, statements } = createFakeConnection({
      roles: ["instructor"],
      adminCount: 1,
    });
    const { decision } = await applyRoleChanges(connection, {
      targetUserId: target,
      actorUserId: actor,
      changes: [
        { operation: "add", role: "student" },
        { operation: "remove", role: "admin" },
      ],
    });
    // The first change did run inside the transaction, then was discarded.
    expect(statements.some((s) => s.sql.includes("array_append"))).toBe(true);
    expect(decision.allowed).toBe(false);
    expect(decision.statusCode).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  test("propagates database errors instead of reporting a decision", async () => {
    const failing = {
      begin: async () => {
        throw new Error("connection lost");
      },
    };
    await expect(
      applyRoleChanges(failing, {
        targetUserId: target,
        actorUserId: actor,
        changes: [{ operation: "add", role: "instructor" }],
      }),
    ).rejects.toThrow("connection lost");
  });
});
