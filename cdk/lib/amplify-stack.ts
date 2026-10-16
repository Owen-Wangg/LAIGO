import {
  App,
  GitHubSourceCodeProvider,
  RedirectStatus,
} from "@aws-cdk/aws-amplify-alpha";
import * as cdk from "aws-cdk-lib";
import { BuildSpec } from "aws-cdk-lib/aws-codebuild";
import { Construct } from "constructs";
import * as yaml from "yaml";
import { ApiGatewayStack } from "./api-stack";
import { applyStandardTags } from "./shared/tagging";

interface AmplifyStackProps extends cdk.StackProps {
  githubRepo: string;
  domainName?: string;
}

export class AmplifyStack extends cdk.Stack {
  public readonly appArn: string;

  constructor(
    scope: Construct,
    id: string,
    apiStack: ApiGatewayStack,
    props: AmplifyStackProps,
  ) {
    super(scope, id, props);
    applyStandardTags(this, "Amplify");

    const githubRepoName = props.githubRepo;

    // Build CSP connect-src directive based on whether a custom domain is configured
    let connectSrc: string;
    if (props.domainName) {
      // Lock down connect-src to specific backends when a custom domain is provided
      const apiEndpoint = apiStack.getEndpointUrl();
      const wsUrl = apiStack.getWebSocketUrl();
      const cognitoIdpEndpoint = `https://cognito-idp.${this.region}.amazonaws.com`;
      const cognitoIdentityEndpoint = `https://cognito-identity.${this.region}.amazonaws.com`;
      const audioPromptBucketEndpoint = `https://${apiStack.getAudioPromptBucketName()}.s3.${this.region}.amazonaws.com`;
      const whitelistUploadBucketEndpoint = `https://${apiStack.getWhitelistUploadBucketName()}.s3.${this.region}.amazonaws.com`;
      connectSrc = `'self' ${apiEndpoint} ${wsUrl} ${cognitoIdpEndpoint} ${cognitoIdentityEndpoint} ${audioPromptBucketEndpoint} ${whitelistUploadBucketEndpoint}`;
    } else {
      // Permissive connect-src when no custom domain is configured
      connectSrc = "'self' wss: https:";
    }

    const amplifyYaml = yaml.parse(` 
      version: 1
      applications:
        - appRoot: frontend
          frontend:
            phases:
              preBuild:
                commands:
                  - pwd
                  - npm ci
              build:
                commands:
                  - npm run build
            artifacts:
              baseDirectory: dist
              files:
                - '**/*'
            cache:
              paths:
                - 'node_modules/**/*'
            customHeaders:
              - pattern: '**/*'
                headers:
                  - key: Content-Security-Policy
                    value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src ${connectSrc}; frame-ancestors 'none';"
                  - key: X-Frame-Options
                    value: DENY
                  - key: X-Content-Type-Options
                    value: nosniff
                  - key: Strict-Transport-Security
                    value: max-age=31536000; includeSubDomains
                  - key: Referrer-Policy
                    value: strict-origin-when-cross-origin
            redirects:
              - source: </^[^.]+$|.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>
                target: /
                status: 404
    `);

    const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "laigo-owner-name",
    );

    const amplifyApp = new App(this, `${id}-amplifyApp`, {
      appName: `${id}-amplify`,
      sourceCodeProvider: new GitHubSourceCodeProvider({
        owner: username,
        repository: githubRepoName,
        oauthToken: cdk.SecretValue.secretsManager(
          "github-personal-access-token",
          {
            jsonField: "my-github-token",
          },
        ),
      }),
      environmentVariables: {
        VITE_AWS_REGION: this.region,
        VITE_COGNITO_USER_POOL_ID: apiStack.getUserPoolId(),
        VITE_COGNITO_USER_POOL_CLIENT_ID: apiStack.getUserPoolClientId(),
        // API Gateway's url ends with a trailing slash (".../prod/"); strip it
        // so frontend calls build ".../prod/student/..." not ".../prod//student/...".
        VITE_API_ENDPOINT: apiStack.getEndpointUrl().replace(/\/+$/, ""),
        VITE_IDENTITY_POOL_ID: apiStack.getIdentityPoolId(),
        VITE_WEBSOCKET_URL: apiStack.getWebSocketUrl(),
      },
      buildSpec: BuildSpec.fromObjectToYaml(amplifyYaml),
    });

    amplifyApp.addCustomRule({
      source: "/<*>",
      target: "\t/index.html",
      status: RedirectStatus.NOT_FOUND_REWRITE,
    });

    const mainBranch = amplifyApp.addBranch("main");

    // Configure custom domain when domainName is provided
    if (props.domainName) {
      const domain = amplifyApp.addDomain(props.domainName);
      domain.mapRoot(mainBranch);
    }

    // Export Amplify app ARN for WAF association
    this.appArn = amplifyApp.arn;
  }

  public getAppArn(): string {
    return this.appArn;
  }
}
