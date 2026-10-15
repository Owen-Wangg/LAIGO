// Unit tests for the pure role-change guard used by PUT /admin/user_role.
// The module is plain JS (shared with the Lambda runtime), required directly.
const {
  evaluateRoleChange,
} = require("../lambda/handlers/utils/roleChange");

describe("evaluateRoleChange", () => {
  const actor = "admin-1";
  const other = "user-2";

  describe("separation of duties on admin role", () => {
    test("blocks an admin adding admin to their own account", () => {
      const result = evaluateRoleChange({
        currentRoles: ["admin"],
        operation: "add",
        role: "admin",
        actorUserId: actor,
        targetUserId: actor,
        totalAdminCount: 3,
      });
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(403);
    });

    test("blocks an admin removing admin from their own account", () => {
      const result = evaluateRoleChange({
        currentRoles: ["admin", "instructor"],
        operation: "remove",
        role: "admin",
        actorUserId: actor,
        targetUserId: actor,
        totalAdminCount: 3,
      });
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(403);
    });

    test("blocks removing the last remaining admin", () => {
      const result = evaluateRoleChange({
        currentRoles: ["admin", "instructor"],
        operation: "remove",
        role: "admin",
        actorUserId: actor,
        targetUserId: other,
        totalAdminCount: 1,
      });
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toMatch(/last remaining admin/i);
    });

    test("allows an admin granting admin to a different user", () => {
      const result = evaluateRoleChange({
        currentRoles: ["student"],
        operation: "add",
        role: "admin",
        actorUserId: actor,
        targetUserId: other,
        totalAdminCount: 2,
      });
      expect(result.allowed).toBe(true);
      expect(result.rolesAfter).toEqual(["student", "admin"]);
    });

    test("allows removing admin from a different user when others remain", () => {
      const result = evaluateRoleChange({
        currentRoles: ["admin", "instructor"],
        operation: "remove",
        role: "admin",
        actorUserId: actor,
        targetUserId: other,
        totalAdminCount: 2,
      });
      expect(result.allowed).toBe(true);
      expect(result.rolesAfter).toEqual(["instructor"]);
    });
  });

  describe("non-admin self changes", () => {
    test("allows a user changing a non-admin role on their own account", () => {
      const result = evaluateRoleChange({
        currentRoles: ["student", "instructor"],
        operation: "remove",
        role: "instructor",
        actorUserId: actor,
        targetUserId: actor,
        totalAdminCount: 5,
      });
      expect(result.allowed).toBe(true);
      expect(result.rolesAfter).toEqual(["student"]);
    });
  });

  describe("preserved legacy validation", () => {
    test("rejects an invalid role", () => {
      const result = evaluateRoleChange({
        currentRoles: ["student"],
        operation: "add",
        role: "superuser",
        actorUserId: actor,
        targetUserId: other,
        totalAdminCount: 2,
      });
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toMatch(/invalid role/i);
    });

    test("rejects an invalid operation", () => {
      const result = evaluateRoleChange({
        currentRoles: ["student"],
        operation: "toggle",
        role: "instructor",
        actorUserId: actor,
        targetUserId: other,
        totalAdminCount: 2,
      });
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toMatch(/invalid operation/i);
    });

    test("rejects removing a role the user does not have", () => {
      const result = evaluateRoleChange({
        currentRoles: ["student"],
        operation: "remove",
        role: "instructor",
        actorUserId: actor,
        targetUserId: other,
        totalAdminCount: 2,
      });
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toMatch(/does not have this role/i);
    });

    test("rejects removing the user's only role", () => {
      const result = evaluateRoleChange({
        currentRoles: ["student"],
        operation: "remove",
        role: "student",
        actorUserId: actor,
        targetUserId: other,
        totalAdminCount: 2,
      });
      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toMatch(/only role/i);
    });

    test("adding a role the user already has is a no-op that keeps roles", () => {
      const result = evaluateRoleChange({
        currentRoles: ["student", "instructor"],
        operation: "add",
        role: "instructor",
        actorUserId: actor,
        targetUserId: other,
        totalAdminCount: 2,
      });
      expect(result.allowed).toBe(true);
      expect(result.rolesAfter).toEqual(["student", "instructor"]);
    });
  });
});
