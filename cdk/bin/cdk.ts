#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import { VpcStack } from "../lib/vpc-stack";
import { DatabaseStack } from "../lib/database-stack";
import { DBFlowStack } from "../lib/dbFlow-stack";
import { CICDStack } from "../lib/cicd-stack";
import { ApiGatewayStack } from "../lib/api-stack";
import { AmplifyStack } from "../lib/amplify-stack";
import { WafStack } from "../lib/waf-stack";
import { applyGlobalTags, TagValidationAspect } from "../lib/shared/tagging";

const app = new cdk.App();

// Parse params from command line with defaults
const StackPrefix = app.node.tryGetContext("StackPrefix");
const environment = app.node.tryGetContext("Environment");
const githubRepo = app.node.tryGetContext("GithubRepo");
const domainName = app.node.tryGetContext("DomainName") || "";
const frontendOrigin = app.node.tryGetContext("FrontendOrigin") || "";
const sesVerifiedDomain = app.node.tryGetContext("SesVerifiedDomain") || "";

// Centralized tagging — replaces inline cdk.Tags.of(app).add() calls
applyGlobalTags(app);

// grab account and region info
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// CloudFront WAF must be in us-east-1
const usEast1Env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: "us-east-1",
};

const vpc = new VpcStack(app, `${StackPrefix}-VpcStack`, {
  env,
  stackPrefix: StackPrefix,
});

const db = new DatabaseStack(app, `${StackPrefix}-DatabaseStack`, vpc, { env });
// Ensure database waits for VPC
db.addDependency(vpc);

const dbFlow = new DBFlowStack(app, `${StackPrefix}-DBFlowStack`, vpc, db, {
  env,
});
// Ensure dbFlow waits for database
dbFlow.addDependency(db);

const cicd = new CICDStack(app, `${StackPrefix}-CICDStack`, {
  env,
  githubRepo: githubRepo,
  environmentName: environment,
  lambdaFunctions: [
    {
      name: "textGeneration",
      functionName: `${StackPrefix}-ApiStack-TextGenLambdaDockerFunction`,
      sourceDir: "cdk/lambda/text_generation",
    },
    {
      name: "playgroundGeneration",
      functionName: `${StackPrefix}-ApiStack-PlaygroundTextGenLambdaDockerFunction`,
      sourceDir: "cdk/lambda/playground_generation",
    },
  ],
  pathFilters: [
    "cdk/lambda/text_generation/**",
    "cdk/lambda/playground_generation/**",
    "cdk/layers/bedrock_client/**",
  ],
});

const api = new ApiGatewayStack(app, `${StackPrefix}-ApiStack`, db, vpc, {
  env,
  ecrRepositories: cicd.ecrRepositories,
  domainName: domainName,
  frontendOrigin: frontendOrigin,
  sesVerifiedDomain: sesVerifiedDomain,
});
// Ensure API waits for database and dbFlow (change to CICD stack later)
api.addDependency(db);
api.addDependency(dbFlow);
api.addDependency(cicd);

const amplify = new AmplifyStack(app, `${StackPrefix}-AmplifyStack`, api, {
  env,
  githubRepo: githubRepo,
  domainName: domainName,
});
// Ensure Amplify waits for API
amplify.addDependency(api);

// Create WAF stack in us-east-1 (required for CloudFront)
// Pass Amplify app ARN for WAF association
new WafStack(app, `${StackPrefix}-WafStack`, {
  env: usEast1Env,
  crossRegionReferences: true,
  amplifyAppArn: amplify.getAppArn(),
});

// Validate all resources have required tags during synthesis
Aspects.of(app).add(new TagValidationAspect());
