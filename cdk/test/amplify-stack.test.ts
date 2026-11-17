import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Template } from "aws-cdk-lib/assertions";
import { AmplifyStack } from "../lib/amplify-stack";
import { ApiGatewayStack } from "../lib/api-stack";
import { DatabaseStack } from "../lib/database-stack";
import { VpcStack } from "../lib/vpc-stack";

const testEnv = { account: "111122223333", region: "us-east-1" };

// Values that reference other stacks are CloudFormation Fn::Join arrays. Join
// the literal parts and mark each reference, so the text can be searched.
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  const parts = (value as { "Fn::Join"?: [string, unknown[]] })?.["Fn::Join"];
  if (parts) {
    return parts[1]
      .map((part) => (typeof part === "string" ? part : "<ref>"))
      .join(parts[0]);
  }
  return "<ref>";
}

describe("AmplifyStack browser security headers", () => {
  jest.setTimeout(300_000);
  let template: Template;
  let customHeaders: string;
  let buildSpec: string;

  beforeAll(() => {
    const app = new cdk.App({ context: { Environment: "prod" } });
    const vpc = new VpcStack(app, "TestVpc", {
      env: testEnv,
      stackPrefix: "Test",
    });
    const db = new DatabaseStack(app, "TestDb", vpc, { env: testEnv });
    const ecrStack = new cdk.Stack(app, "TestEcr", { env: testEnv });
    const api = new ApiGatewayStack(app, "TestApiStack", db, vpc, {
      env: testEnv,
      domainName: "app.example.com",
      ecrRepositories: {
        textGeneration: new ecr.Repository(ecrStack, "TextGenRepo", {
          repositoryName: "test-laigo-textgen",
        }),
        playgroundGeneration: new ecr.Repository(ecrStack, "PlaygroundRepo", {
          repositoryName: "test-laigo-playground",
        }),
      },
    });
    api.addDependency(db);
    const amplify = new AmplifyStack(app, "TestAmplify", api, {
      env: testEnv,
      githubRepo: "laigo",
      domainName: "app.example.com",
    });
    template = Template.fromStack(amplify);
    const apps = Object.values(template.findResources("AWS::Amplify::App"));
    expect(apps).toHaveLength(1);
    customHeaders = flatten(apps[0].Properties.CustomHeaders);
    buildSpec = flatten(apps[0].Properties.BuildSpec);
  });

  test("headers are set on the app, not inside the build spec", () => {
    expect(customHeaders).toBeDefined();
    expect(customHeaders).toContain("customHeaders:");
    expect(buildSpec).not.toContain("customHeaders");
    expect(buildSpec).not.toContain("Content-Security-Policy");
  });

  test("headers are scoped to the frontend app root", () => {
    expect(customHeaders).toContain("appRoot: frontend");
  });

  test("the policy forbids inline and eval script execution", () => {
    const scriptSrc = /script-src ([^;]*);/.exec(customHeaders)?.[1];
    expect(scriptSrc).toBe("'self'");
    expect(customHeaders).not.toContain("unsafe-eval");
  });

  test("the policy blocks plugins and base tag injection", () => {
    expect(customHeaders).toContain("object-src 'none'");
    expect(customHeaders).toContain("base-uri 'self'");
    expect(customHeaders).toContain("frame-ancestors 'none'");
  });

  test("the other security headers are present", () => {
    for (const header of [
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Strict-Transport-Security",
      "Referrer-Policy",
    ]) {
      expect(customHeaders).toContain(header);
    }
  });
});