# LAIGO CDK

AWS CDK v2 (TypeScript) app that deploys the LAIGO backend: VPC, RDS PostgreSQL with RDS Proxy, database migrations, API Gateway (REST and WebSocket), Cognito, Lambda functions, CI/CD pipeline, Amplify hosting, and WAF.

The app entry point is `bin/cdk.ts`. Stack definitions live in `lib/`, Lambda source in `lambda/`, and Lambda layers in `layers/`.

For the full deployment procedure, including the required secrets, SSM parameters, and context values (`StackPrefix`, `Environment`, `GithubRepo`, and the optional ones), see the [Deployment Guide](../docs/deploymentGuide.md).

## Useful commands

Run these from the `cdk/` directory:

- `npm run build`: compile TypeScript with `tsc`
- `npm run watch`: recompile on change
- `npm test`: run the Jest unit and property tests in `test/`
- `npx cdk synth --all --context StackPrefix=<prefix> --context GithubRepo=<repo>`: synthesize the CloudFormation templates
- `npx cdk diff --all --context StackPrefix=<prefix> --context GithubRepo=<repo>`: compare the deployed stacks with the current code
- `npx cdk deploy --all --context StackPrefix=<prefix> --context Environment=<dev|test|prod> --context GithubRepo=<repo>`: deploy all stacks

`StackPrefix` is required; synthesis fails without it.
