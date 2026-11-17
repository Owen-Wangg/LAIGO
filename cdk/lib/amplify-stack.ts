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
import { isProdEnvironment } from "./shared/environment";

interface AmplifyStackProps extends cdk.StackProps {
  githubRepo: string;
  domainName?: string;
  frontendOrigin?: string;
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

    const isProd = isProdEnvironment(this);

    // Resolve the single concrete frontend origin, mirroring ApiGatewayStack:
    // a custom domain (bare host) becomes https://<host>; an explicit
    // frontendOrigin (full URL) is used verbatim with any trailing slash removed.
    const allowedOrigin = props.domainName
      ? `https://${props.domainName}`
      : props.frontendOrigin
        ? props.frontendOrigin.replace(/\/+$/, "")
        : "";

    // Reject anything that is not a single concrete https origin, so a malformed
    // value cannot both pass the prod guard below and corrupt the CSP header.
    if (
      allowedOrigin &&
      !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(allowedOrigin)
    ) {
      throw new Error(
        `Invalid frontend origin "${allowedOrigin}". Provide a single concrete https origin, e.g. https://app.example.com (pass -c DomainName as a bare host, or -c FrontendOrigin as a full https URL).`,
      );
    }

    // Fail closed in production: never serve the permissive connect-src. This is
    // environment-driven (not truthiness-driven) so an unset DomainName AND
    // FrontendOrigin cannot silently fall through to the permissive branch.
    if (isProd && !allowedOrigin) {
      throw new Error(
        "A frontend origin is required for production deployments so the CSP connect-src is locked down. Pass -c DomainName=your.domain for a custom domain, or -c FrontendOrigin=https://main.xxxxx.amplifyapp.com to use the Amplify-managed domain.",
      );
    }

    // Build the CSP connect-src directive. When a concrete origin is configured
    // (always true in prod given the guard above), lock it down to the specific
    // backends the SPA talks to plus the frontend origin itself.
    let connectSrc: string;
    if (allowedOrigin) {
      const apiEndpoint = apiStack.getEndpointUrl();
      const wsUrl = apiStack.getWebSocketUrl();
      const cognitoIdpEndpoint = `https://cognito-idp.${this.region}.amazonaws.com`;
      const cognitoIdentityEndpoint = `https://cognito-identity.${this.region}.amazonaws.com`;
      const audioPromptBucketEndpoint = `https://${apiStack.getAudioPromptBucketName()}.s3.${this.region}.amazonaws.com`;
      const whitelistUploadBucketEndpoint = `https://${apiStack.getWhitelistUploadBucketName()}.s3.${this.region}.amazonaws.com`;
      connectSrc = `'self' ${allowedOrigin} ${apiEndpoint} ${wsUrl} ${cognitoIdpEndpoint} ${cognitoIdentityEndpoint} ${audioPromptBucketEndpoint} ${whitelistUploadBucketEndpoint}`;
    } else {
      // Only reachable for non-prod deployments with no configured origin.
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
    `);

    // Browser security headers. Amplify applies headers set on the app, not
    // ones placed inside the build spec's frontend section, so they are passed
    // as custom response headers. The build is a Vite bundle with no inline
    // scripts and no eval, so script-src allows only same-origin files.
    // style-src keeps 'unsafe-inline' because the UI library injects styles.
    const contentSecurityPolicy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      `connect-src ${connectSrc}`,
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join("; ") + ";";

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
      customResponseHeaders: [
        {
          appRoot: "frontend",
          pattern: "**/*",
          headers: {
            "Content-Security-Policy": contentSecurityPolicy,
            "X-Frame-Options": "DENY",
            "X-Content-Type-Options": "nosniff",
            "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
            "Referrer-Policy": "strict-origin-when-cross-origin",
          },
        },
      ],
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
