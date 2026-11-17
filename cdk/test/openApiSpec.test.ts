// The API is deployed from OpenAPI_Swagger_Definition.yaml, uploaded as an
// asset and included by a CloudFormation transform, so its contents are not in
// the synthesized template. These tests read the file directly.
import * as fs from "fs";
import * as path from "path";

const spec = fs.readFileSync(
  path.join(__dirname, "../OpenAPI_Swagger_Definition.yaml"),
  "utf8",
);

describe("OpenAPI request validators", () => {
  // Lines of the x-amazon-apigateway-request-validators block, up to the next
  // top-level key.
  const block = spec
    .split(/\r?\n/)
    .reduce<{ inside: boolean; lines: string[] }>(
      (acc, line) => {
        if (line.startsWith("x-amazon-apigateway-request-validators:")) {
          return { inside: true, lines: acc.lines };
        }
        if (acc.inside && /^\S/.test(line)) {
          return { inside: false, lines: acc.lines };
        }
        if (acc.inside) acc.lines.push(line);
        return acc;
      },
      { inside: false, lines: [] },
    ).lines;

  test("the validators block is present", () => {
    expect(block.length).toBeGreaterThan(0);
  });

  test("every validator setting is spelled correctly", () => {
    // A stray quote or typo in a key makes API Gateway ignore the setting and
    // leave validation off.
    const settingKeys = block
      .map((line) => line.match(/^\s{4}(\S+):/)?.[1])
      .filter((key): key is string => Boolean(key));
    expect(settingKeys.length).toBeGreaterThan(0);
    for (const key of settingKeys) {
      expect(["validateRequestParameters", "validateRequestBody"]).toContain(
        key,
      );
    }
  });

  test("the default validator checks request parameters", () => {
    const defaultName = spec.match(
      /^x-amazon-apigateway-request-validator:\s*(\S+)/m,
    )?.[1];
    expect(defaultName).toBeDefined();
    const start = block.findIndex((line) =>
      new RegExp(`^\\s{2}${defaultName}:`).test(line),
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const following = block.slice(start + 1);
    const end = following.findIndex((line) => /^\s{2}\S/.test(line));
    const settings = (end === -1 ? following : following.slice(0, end)).join(
      "\n",
    );
    expect(settings).toMatch(/validateRequestParameters:\s*true/);
  });
});

describe("OpenAPI authorizer caching", () => {
  // The authorizer Lambdas keep their own user cache for 60 seconds and are
  // written to catch revoked roles within that window. A longer gateway cache
  // would keep a revoked role working for its whole length.
  test("every authorizer result is cached for at most 60 seconds", () => {
    const ttls = [...spec.matchAll(/authorizerResultTtlInSeconds:\s*(\d+)/g)].map(
      (m) => Number(m[1]),
    );
    expect(ttls.length).toBeGreaterThan(0);
    for (const ttl of ttls) {
      expect(ttl).toBeLessThanOrEqual(60);
    }
  });
});
