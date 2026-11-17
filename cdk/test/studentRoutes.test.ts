// The student handler repeats the authorizer's role rules as a second layer.
// These tests check the rule itself and that the two copies stay in sync.
const fs = require("fs");
const path = require("path");
const {
  isRouteAllowedForRoles,
  SHARED_ROUTES,
  INSTRUCTOR_CASE_ROUTES,
} = require("../lambda/handlers/utils/studentRoutes");

function routesInAuthorizerSet(source: string, setName: string): string[] {
  const match = source.match(
    new RegExp(`const ${setName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`),
  );
  expect(match).not.toBeNull();
  return [...(match as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)].map(
    (m) => m[1],
  );
}

describe("isRouteAllowedForRoles", () => {
  test("a student may use any student route", () => {
    expect(isRouteAllowedForRoles("POST /student/new_case", ["student"])).toBe(
      true,
    );
  });

  test("an instructor without the student role is limited to the case view routes", () => {
    expect(isRouteAllowedForRoles("GET /student/case_page", ["instructor"])).toBe(
      true,
    );
    expect(
      isRouteAllowedForRoles("PUT /student/edit_case", ["instructor"]),
    ).toBe(false);
    expect(
      isRouteAllowedForRoles("GET /student/generate_summary", ["instructor"]),
    ).toBe(false);
  });

  test("an admin without the student role gets only the shared routes", () => {
    expect(isRouteAllowedForRoles("GET /student/profile", ["admin"])).toBe(true);
    expect(isRouteAllowedForRoles("GET /student/case_page", ["admin"])).toBe(
      false,
    );
  });

  test("a caller with no roles gets only the shared routes", () => {
    expect(isRouteAllowedForRoles("GET /student/profile", [])).toBe(true);
    expect(isRouteAllowedForRoles("GET /student/all_cases", [])).toBe(false);
    expect(isRouteAllowedForRoles("GET /student/all_cases", undefined)).toBe(
      false,
    );
  });
});

describe("student route lists match the authorizer", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "../lambda/authorization/studentAuthorizerFunction.js",
    ),
    "utf8",
  );

  test("shared routes are identical", () => {
    expect([...SHARED_ROUTES].sort()).toEqual(
      routesInAuthorizerSet(source, "sharedRoutes").sort(),
    );
  });

  test("instructor case routes are identical", () => {
    expect([...INSTRUCTOR_CASE_ROUTES].sort()).toEqual(
      routesInAuthorizerSet(source, "instructorCaseRoutes").sort(),
    );
  });
});