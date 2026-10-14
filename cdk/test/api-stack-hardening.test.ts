import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ApiGatewayStack } from "../lib/api-stack";
import { DatabaseStack } from "../lib/database-stack";
import { VpcStack } from "../lib/vpc-stack";

const testEnv = { account: "111122223333", region: "us-east-1" };

function synthApiStack(options: {
  environment?: string;
  domainName?: string;
  frontendOrigin?: string;
}): ApiGatewayStack {
  const app = new cdk.App({
    context:
      options.environment === undefined
        ? {}
        : { Environment: options.environment },
  });
  const vpc = new VpcStack(app, "TestVpc", {
    env: testEnv,
    stackPrefix: "Test",
  });
  const db = new DatabaseStack(app, "TestDb", vpc, { env: testEnv });
  const ecrStack = new cdk.Stack(app, "TestEcr", { env: testEnv });
  const textRepo = new ecr.Repository(ecrStack, "TextGenRepo", {
    repositoryName: "test-laigo-textgen",
  });
  const playgroundRepo = new ecr.Repository(ecrStack, "PlaygroundGenRepo", {
    repositoryName: "test-laigo-playground",
  });

  const api = new ApiGatewayStack(app, "TestApiStack", db, vpc, {
    env: testEnv,
    domainName: options.domainName,
    frontendOrigin: options.frontendOrigin,
    ecrRepositories: {
      textGeneration: textRepo,
      playgroundGeneration: playgroundRepo,
    },
  });
  api.addDependency(db);
  return api;
}

describe("ApiGatewayStack production hardening", () => {
  jest.setTimeout(300_000);

  let template: Template;

  beforeAll(() => {
    const api = synthApiStack({
      environment: "prod",
      domainName: "app.example.com",
    });
    template = Template.fromStack(api);
  });

  test("the data buckets are retained on stack deletion", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    const dataBucketKeys = Object.keys(buckets).filter(
      (key) => /WhitelistUploadBucket|audiopromptbucket/i.test(key),
    );
    expect(dataBucketKeys).toHaveLength(2);
    for (const key of dataBucketKeys) {
      expect(buckets[key].DeletionPolicy).toBe("Retain");
      expect(buckets[key].UpdateReplacePolicy).toBe("Retain");
    }
  });

  test("API Gateway stage disables full request/response body logging", () => {
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      MethodSettings: Match.arrayWith([
        Match.objectLike({ DataTraceEnabled: false }),
      ]),
    });
  });

  test("Bedrock model-invocation logging disables prompt/completion text delivery", () => {
    const serialized = JSON.stringify(template.toJSON());
    expect(serialized).toContain('textDataDeliveryEnabled\\":false');
    expect(serialized).not.toContain('textDataDeliveryEnabled\\":true');
  });

  test("Bedrock logging role does not use the CloudWatchLogsFullAccess managed policy", () => {
    const serialized = JSON.stringify(template.toJSON());
    expect(serialized).not.toContain("CloudWatchLogsFullAccess");
  });

  test("WAF API logging redacts the Authorization header", () => {
    template.hasResourceProperties("AWS::WAFv2::LoggingConfiguration", {
      RedactedFields: Match.arrayWith([
        Match.objectLike({ SingleHeader: { Name: "authorization" } }),
      ]),
    });
  });

  test("all five security alarms notify the security topic", () => {
    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    const alarmKeys = Object.keys(alarms);
    expect(alarmKeys.length).toBeGreaterThanOrEqual(5);
    for (const key of alarmKeys) {
      const actions = alarms[key].Properties?.AlarmActions;
      expect(Array.isArray(actions)).toBe(true);
      expect(actions.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("SignupMode SSM parameter defaults to whitelist", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/LAIGO/SignupMode",
      Value: "whitelist",
    });
  });
});

describe("ApiGatewayStack production guardrails", () => {
  jest.setTimeout(300_000);

  test("prod without any frontend origin fails synth", () => {
    expect(() => synthApiStack({ environment: "prod" })).toThrow(
      /frontend origin is required for production/,
    );
  });

  test.each([
    "*",
    "http://evil.example",
    "https://a.example.com,https://b.example.com",
    "https://app.example.com/path",
    "https://app.example.com' injected",
  ])("rejects a non-concrete-https frontend origin: %s", (bad) => {
    expect(() =>
      synthApiStack({ environment: "prod", frontendOrigin: bad }),
    ).toThrow(/Invalid frontend origin/);
  });

  test("accepts a concrete https origin with a port", () => {
    expect(() =>
      synthApiStack({
        environment: "prod",
        frontendOrigin: "https://app.example.com:8443",
      }),
    ).not.toThrow();
  });

  test("rejects a custom domain that is not a bare host", () => {
    expect(() =>
      synthApiStack({ environment: "prod", domainName: "app.example.com/x" }),
    ).toThrow(/Invalid frontend origin/);
  });

  test("dev defaults keep public signup", () => {
    const api = synthApiStack({ environment: "dev" });
    const template = Template.fromStack(api);
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/LAIGO/SignupMode",
      Value: "public",
    });
  });

  test("dev also disables full request/response body logging", () => {
    const api = synthApiStack({ environment: "dev" });
    const template = Template.fromStack(api);
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      MethodSettings: Match.arrayWith([
        Match.objectLike({ DataTraceEnabled: false }),
      ]),
    });
  });
});

describe("ApiGatewayStack frontend origin without a custom domain", () => {
  jest.setTimeout(300_000);

  const origin = "https://main.xxxxx.amplifyapp.com";
  let template: Template;

  beforeAll(() => {
    const api = synthApiStack({ environment: "prod", frontendOrigin: origin });
    template = Template.fromStack(api);
  });

  test("prod synth succeeds when only a frontend origin is provided", () => {
    expect(() =>
      synthApiStack({ environment: "prod", frontendOrigin: origin }),
    ).not.toThrow();
  });

  test("data bucket CORS locks to the frontend origin only", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({ AllowedOrigins: [origin] }),
        ]),
      },
    });
  });

  test("the API Gateway spec is uploaded as an asset (no CORS CfnParameter)", () => {
    const params = (template.toJSON().Parameters ?? {}) as Record<
      string,
      unknown
    >;
    expect(Object.keys(params)).not.toContain("CorsAllowedOrigin");
    template.hasResource("AWS::ApiGateway::RestApi", {});
  });

  test("a trailing slash on the frontend origin is stripped", () => {
    const api = synthApiStack({
      environment: "prod",
      frontendOrigin: `${origin}/`,
    });
    Template.fromStack(api).hasResourceProperties("AWS::S3::Bucket", {
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({ AllowedOrigins: [origin] }),
        ]),
      },
    });
  });
});
