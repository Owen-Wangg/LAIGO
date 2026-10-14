import * as cdk from "aws-cdk-lib";
import {
  resolveEnvironment,
  isProdEnvironment,
  getEnvironmentName,
} from "../lib/shared/environment";
import { applyGlobalTags } from "../lib/shared/tagging";

describe("resolveEnvironment", () => {
  test("accepts the canonical values dev/test/prod", () => {
    expect(resolveEnvironment("dev")).toBe("dev");
    expect(resolveEnvironment("test")).toBe("test");
    expect(resolveEnvironment("prod")).toBe("prod");
  });

  test("maps the production alias to prod", () => {
    expect(resolveEnvironment("production")).toBe("prod");
    expect(resolveEnvironment("Production")).toBe("prod");
    expect(resolveEnvironment("  PRODUCTION  ")).toBe("prod");
  });

  test("maps the development alias to dev", () => {
    expect(resolveEnvironment("development")).toBe("dev");
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(resolveEnvironment("  Dev ")).toBe("dev");
    expect(resolveEnvironment("TEST")).toBe("test");
  });

  test("defaults to dev when unset or empty", () => {
    expect(resolveEnvironment(undefined)).toBe("dev");
    expect(resolveEnvironment("")).toBe("dev");
    expect(resolveEnvironment("   ")).toBe("dev");
  });

  test("throws on an unrecognized value", () => {
    expect(() => resolveEnvironment("staging")).toThrow(/Invalid Environment/);
    expect(() => resolveEnvironment("prd")).toThrow(/Invalid Environment/);
  });
});

describe("isProdEnvironment / getEnvironmentName", () => {
  function stackWithEnv(environment?: string): cdk.Stack {
    const app = new cdk.App({
      context: environment === undefined ? {} : { Environment: environment },
    });
    return new cdk.Stack(app, "ScopeStack");
  }

  test("isProdEnvironment is true for prod and the production alias", () => {
    expect(isProdEnvironment(stackWithEnv("prod"))).toBe(true);
    expect(isProdEnvironment(stackWithEnv("production"))).toBe(true);
  });

  test("isProdEnvironment is false for dev/test and when unset", () => {
    expect(isProdEnvironment(stackWithEnv("dev"))).toBe(false);
    expect(isProdEnvironment(stackWithEnv("test"))).toBe(false);
    expect(isProdEnvironment(stackWithEnv())).toBe(false);
  });

  test("getEnvironmentName returns the canonical name", () => {
    expect(getEnvironmentName(stackWithEnv("production"))).toBe("prod");
    expect(getEnvironmentName(stackWithEnv("development"))).toBe("dev");
    expect(getEnvironmentName(stackWithEnv())).toBe("dev");
  });
});

describe("applyGlobalTags Environment validation", () => {
  function appWithContext(context: Record<string, string>): cdk.App {
    return new cdk.App({ context });
  }

  test("throws when Environment is outside the accepted set", () => {
    const app = appWithContext({ StackPrefix: "Test", Environment: "staging" });
    expect(() => applyGlobalTags(app)).toThrow(/Invalid Environment/);
  });

  test("does not throw for canonical values and aliases", () => {
    for (const environment of ["dev", "test", "prod", "production", "development"]) {
      const app = appWithContext({ StackPrefix: "Test", Environment: environment });
      expect(() => applyGlobalTags(app)).not.toThrow();
    }
  });

  test("does not throw when Environment is unset", () => {
    const app = appWithContext({ StackPrefix: "Test" });
    expect(() => applyGlobalTags(app)).not.toThrow();
  });

  test("applies the canonical environment value as the Environment tag", () => {
    const app = appWithContext({ StackPrefix: "Test", Environment: "production" });
    applyGlobalTags(app);
    const stack = new cdk.Stack(app, "TaggedStack");
    new cdk.aws_s3.CfnBucket(stack, "Bucket");
    const synthStack = app.synth().getStackByName("TaggedStack");
    const bucket = Object.values(synthStack.template.Resources).find(
      (r: unknown) => (r as { Type: string }).Type === "AWS::S3::Bucket",
    ) as { Properties: { Tags: Array<{ Key: string; Value: string }> } };
    const envTag = bucket.Properties.Tags.find((t) => t.Key === "Environment");
    expect(envTag?.Value).toBe("prod");
  });
});
