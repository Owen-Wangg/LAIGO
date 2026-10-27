import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Template } from "aws-cdk-lib/assertions";
import { ApiGatewayStack } from "../lib/api-stack";
import { DatabaseStack } from "../lib/database-stack";
import { VpcStack } from "../lib/vpc-stack";

const testEnv = { account: "111122223333", region: "us-east-1" };

function synthApiStack() {
  const app = new cdk.App();
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
    ecrRepositories: {
      textGeneration: textRepo,
      playgroundGeneration: playgroundRepo,
    },
  });
  api.addDependency(db);
  return { app, api };
}

interface CfnResource {
  Type: string;
  Properties?: {
    Name?: string;
    Value?: string;
    PolicyDocument?: {
      Statement?: Array<{
        Action?: string | string[];
        Resource?: string | string[];
      }>;
    };
  };
}

function findSsmParameter(
  template: Template,
  name: string,
): CfnResource["Properties"] | undefined {
  const resources = template.toJSON().Resources as Record<string, CfnResource>;
  for (const res of Object.values(resources)) {
    if (
      res.Type === "AWS::SSM::Parameter" &&
      res.Properties?.Name === name
    ) {
      return res.Properties;
    }
  }
  return undefined;
}

describe("ApiGatewayStack Bedrock model options array", () => {
  jest.setTimeout(300_000);

  let template: Template;

  beforeAll(() => {
    const { api } = synthApiStack();
    template = Template.fromStack(api);
  });

  test("BedrockModelOptionsParameter contains exactly 2 entries", () => {
    const props = findSsmParameter(
      template,
      "/TestApiStack/LAIGO/BedrockModelOptions",
    );
    expect(props?.Value).toBeDefined();
    const opts = JSON.parse(props!.Value!);
    expect(opts).toHaveLength(2);
  });

  test("first entry has label 'Claude Sonnet 5.5'", () => {
    const props = findSsmParameter(
      template,
      "/TestApiStack/LAIGO/BedrockModelOptions",
    );
    const opts = JSON.parse(props!.Value!);
    expect(opts[0].label).toBe("Claude Sonnet 5.5");
  });

  test("first entry value contains cross-region inference profile ARN", () => {
    const props = findSsmParameter(
      template,
      "/TestApiStack/LAIGO/BedrockModelOptions",
    );
    const opts = JSON.parse(props!.Value!);
    expect(opts[0].value).toContain(
      "inference-profile/us.anthropic.claude-sonnet-5-5",
    );
  });

  test("first entry constraints has maxOutputTokens 128000 and defaultMaxOutputTokens 4096", () => {
    const props = findSsmParameter(
      template,
      "/TestApiStack/LAIGO/BedrockModelOptions",
    );
    const opts = JSON.parse(props!.Value!);
    expect(opts[0].constraints.maxOutputTokens).toBe(128000);
    expect(opts[0].constraints.defaultMaxOutputTokens).toBe(4096);
  });

  test("second entry has label 'Llama 3 70b Instruct' with value 'meta.llama3-70b-instruct-v1:0'", () => {
    const props = findSsmParameter(
      template,
      "/TestApiStack/LAIGO/BedrockModelOptions",
    );
    const opts = JSON.parse(props!.Value!);
    expect(opts[1].label).toBe("Llama 3 70b Instruct");
    expect(opts[1].value).toBe("meta.llama3-70b-instruct-v1:0");
  });

  test("second entry constraints has maxOutputTokens 8192 and defaultMaxOutputTokens 2000", () => {
    const props = findSsmParameter(
      template,
      "/TestApiStack/LAIGO/BedrockModelOptions",
    );
    const opts = JSON.parse(props!.Value!);
    expect(opts[1].constraints.maxOutputTokens).toBe(8192);
    expect(opts[1].constraints.defaultMaxOutputTokens).toBe(2000);
  });

  test("both entries preserve temperatureRange [0, 1.0] and topPRange [0, 1.0]", () => {
    const props = findSsmParameter(
      template,
      "/TestApiStack/LAIGO/BedrockModelOptions",
    );
    const opts = JSON.parse(props!.Value!);
    expect(opts[0].constraints.temperatureRange).toEqual([0, 1.0]);
    expect(opts[0].constraints.topPRange).toEqual([0, 1.0]);
    expect(opts[1].constraints.temperatureRange).toEqual([0, 1.0]);
    expect(opts[1].constraints.topPRange).toEqual([0, 1.0]);
  });

  test("BedrockLLMParameter default is Sonnet 5.5 inference profile (matches first model option)", () => {
    const props = findSsmParameter(
      template,
      "/TestApiStack/LAIGO/BedrockLLMId",
    );
    expect(props?.Value).toBeDefined();
    expect(String(props!.Value)).toContain(
      "inference-profile/us.anthropic.claude-sonnet-5-5",
    );
    const optionsProps = findSsmParameter(
      template,
      "/TestApiStack/LAIGO/BedrockModelOptions",
    );
    const opts = JSON.parse(optionsProps!.Value!);
    expect(String(props!.Value)).toBe(opts[0].value);
  });
});
