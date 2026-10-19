import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ApiGatewayStack } from "../lib/api-stack";
import { DatabaseStack } from "../lib/database-stack";
import { VpcStack } from "../lib/vpc-stack";

const testEnv = { account: "111122223333", region: "us-east-1" };

function synthApiStack(): ApiGatewayStack {
  const app = new cdk.App({ context: { Environment: "prod" } });
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
    domainName: "app.example.com",
    ecrRepositories: {
      textGeneration: textRepo,
      playgroundGeneration: playgroundRepo,
    },
  });
  api.addDependency(db);
  return api;
}

describe("ApiGatewayStack admin role-change controls", () => {
  jest.setTimeout(300_000);

  let template: Template;

  beforeAll(() => {
    template = Template.fromStack(synthApiStack());
  });

  test("admin function can publish only to the security-alerts topic", () => {
    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "sns:Publish",
              Resource: Match.objectLike({
                Ref: Match.stringLikeRegexp("SecurityAlerts"),
              }),
            }),
          ]),
        }),
      }),
    );
  });

  test("admin function receives the security-alerts topic ARN as an env var", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          SECURITY_ALERTS_TOPIC_ARN: Match.objectLike({
            Ref: Match.stringLikeRegexp("SecurityAlerts"),
          }),
        }),
      }),
    });
  });
});
