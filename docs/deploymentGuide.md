# Deployment Guide

## Table of Contents

- [Deployment Guide](#deployment-guide)
  - [Table of Contents](#table-of-contents)
  - [Requirements](#requirements)
    - [Base Requirements](#base-requirements)
    - [Custom Domain (Optional)](#custom-domain-optional)
    - [SES Email (Optional)](#ses-email-optional)
  - [Pre-Deployment](#pre-deployment)
    - [Create GitHub Personal Access Token](#create-github-personal-access-token)
    - [Enable Models in Bedrock](#enable-models-in-bedrock)
  - [Deployment](#deployment)
    - [Step 1: Fork \& Clone The Repository](#step-1-fork--clone-the-repository)
    - [Step 2: Upload Secrets](#step-2-upload-secrets)
    - [Step 3: CDK Deployment](#step-3-cdk-deployment)
  - [Post-Deployment](#post-deployment)
    - [Step 1: Verify Bedrock Model Access](#step-1-verify-bedrock-model-access)
    - [Step 2: Request SES Production Access (if using SesVerifiedDomain)](#step-2-request-ses-production-access-if-using-sesverifieddomain)
    - [Step 3: Build AWS Amplify App](#step-3-build-aws-amplify-app)
    - [Step 4: Visit Web App](#step-4-visit-web-app)
  - [Cleanup](#cleanup)
    - [Taking down the deployed stack](#taking-down-the-deployed-stack)
  - [Troubleshooting](#troubleshooting)
    - [Stack Deletion](#stack-deletion)
    - [RDS Master Username Constraints](#rds-master-username-constraints)

## Requirements

### Base Requirements

Before you deploy, ensure the following are available locally:

- [git](https://git-scm.com/downloads)
- [AWS Account](https://aws.amazon.com/account/)
- [GitHub Account](https://github.com/)
- [AWS CLI v2](https://aws.amazon.com/cli/)
- [Node.js](https://nodejs.org/en/download) _(20.x or newer recommended)_
- [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)

You also need AWS credentials configured (`aws configure` or SSO profile), and permissions to create IAM roles, VPC, RDS, API Gateway, Cognito, Lambda, Amplify, CodePipeline, CodeBuild, ECR, WAF, SSM, Secrets Manager, and CloudWatch resources.

### Custom Domain (Optional)

The `DomainName` context parameter lets you serve the frontend on your own domain and lock down CORS to that origin. Without it, the app runs on the default Amplify domain and CORS allows all origins (`*`).

**When you should use this:**

- You want users to access the app at a branded URL (e.g. `app.example.com`)
- You want to restrict API access to requests originating from your domain only (tighter CORS)
- You are deploying to production and want proper security headers scoped to your domain

**What it does:**

- Configures Amplify to serve the frontend on your custom domain
- Locks CORS `Access-Control-Allow-Origin` to `https://<DomainName>` across all API endpoints and the S3 audio bucket
- Tightens the Content-Security-Policy `connect-src` directive to only allow your specific API and WebSocket endpoints
- Local development uses the Vite dev server proxy (configured in `vite.config.ts`) to avoid CORS issues

**Prerequisites:**

- A registered domain with DNS access
- Either a Route 53 hosted zone for the domain, or the ability to add CNAME records via your DNS provider (for Amplify domain verification)

### SES Email (Optional)

The `SesVerifiedDomain` context parameter switches Cognito from its built-in email service to Amazon SES for sending verification codes and password reset emails. This is a separate decision from whether you use a custom domain.

**When you should use this:**

- You expect more than ~50 sign-ups per day. Cognito's built-in email service has a daily sending limit of 50 emails, which is fine for small teams or pilots but will block sign-ups once exceeded.
- You want emails to come from your own domain (e.g. `noreply@example.com`) instead of `no-reply@verificationemail.com`
- You need higher email deliverability or want to avoid emails landing in spam folders

**When you can skip this:**

- You have a small user base (under ~50 users) and Cognito's built-in email is sufficient
- You are running a dev/test environment where email branding does not matter
- You want the simplest possible deployment

**What it does:**

- Creates an SES domain identity with automatic DKIM and MAIL FROM DNS record setup via Route 53
- Configures Cognito to send all emails through SES using `noreply@<SesVerifiedDomain>` as the sender
- Removes the 50 emails/day Cognito sending limit (SES limits apply instead)

**Prerequisites:**

- A **public Route 53 hosted zone** for the domain must exist in the same AWS account as this deployment (CDK creates the required DNS records automatically)
- New AWS accounts start in the SES sandbox, which only allows sending to verified email addresses. You will need to request production access after deployment (see [Post-Deployment Step 2](#step-2-request-ses-production-access-if-using-sesverifieddomain))

**Note:** `SesVerifiedDomain` can be the same domain as `DomainName`, or a completely different one. They are independent parameters.

## Pre-Deployment

### Create GitHub Personal Access Token

This deployment creates:

- an Amplify app connected to GitHub, and
- a CodePipeline source stage connected to GitHub.

You must create a GitHub personal access token (classic) with the `repo` scope. Follow GitHub instructions [here](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic).

**Save the token value securely. You will upload it to AWS Secrets Manager in Step 2.**

> **Important:** The token lets CDK create the Amplify app, but Amplify runs builds through the **Amplify GitHub App**. After deployment, open the Amplify app in the console, reconnect the repository using the GitHub App method, and authorize it on your repo. Until you do this, the Amplify build fails immediately with `Unable to assume specified IAM Role` (this error is about repo access, not IAM). See [setting up Amplify access to GitHub](https://docs.aws.amazon.com/amplify/latest/userguide/setting-up-GitHub-access.html).

### Enable Models in Bedrock

This project provisions Bedrock guardrails and invokes foundation models from Lambda. In Amazon Bedrock Model access, enable at least:

- `meta.llama3-70b-instruct-v1:0`
- `anthropic.claude-sonnet-5` (accessed via cross-region inference profile)

If either model is not enabled in the deployment region, model invocation calls will fail at runtime.

> **Note:** Claude Sonnet 5 is invoked through a cross-region inference profile (`us.anthropic.claude-sonnet-5`), which allows Bedrock to route requests across regions for improved availability. Ensure the model is enabled in at least one US region.

## Deployment

### Step 1: Fork & Clone The Repository

First, fork the repository from the [main branch](https://github.com/UBC-CIC/Legal-Aid-Tool), then clone your fork:

```bash
git clone https://github.com/<YOUR-GITHUB-USERNAME>/Legal-Aid-Tool.git
cd Legal-Aid-Tool
```

#### Install Dependencies

Install dependencies for both CDK infrastructure and frontend build:

```bash
cd cdk
npm install
cd ../frontend
npm install
cd ../cdk
```

### Step 2: Upload Secrets

The current CDK code expects exact secret/parameter names and keys. Use the exact values below.

For every command in this section:

- Keep fixed names exactly as shown (for example `github-personal-access-token`, `laigo-owner-name`, `LAIGOSecrets`, `/LAIGO/AllowedEmailDomains`).
- Replace only values inside angled brackets (`<...>`) with your real values.

#### 1) GitHub token secret (required by Amplify + CodePipeline)

Create a secret named `github-personal-access-token` with JSON key `my-github-token`.

Before running the command, replace:

- `<YOUR-GITHUB-TOKEN>` with your actual GitHub Personal Access Token (classic) value.
- `<YOUR-PROFILE-NAME>` with your AWS CLI profile name.

<details>
<summary>macOS/Linux</summary>

```bash
aws secretsmanager create-secret \
  --name github-personal-access-token \
  --secret-string '{"my-github-token": "<YOUR-GITHUB-TOKEN>"}' \
  --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>Windows CMD</summary>

```cmd
aws secretsmanager create-secret ^
  --name github-personal-access-token ^
  --secret-string "{\"my-github-token\": \"<YOUR-GITHUB-TOKEN>\"}" ^
  --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
aws secretsmanager create-secret `
  --name github-personal-access-token `
  --secret-string '{\"my-github-token\": \"<YOUR-GITHUB-TOKEN>\"}' `
  --profile <YOUR-PROFILE-NAME>
```

</details>

#### 2) GitHub owner SSM parameter (required by Amplify + CodePipeline)

Create SSM parameter `laigo-owner-name` with your GitHub username.

Before running the command, replace:

- `<YOUR-GITHUB-USERNAME>` with your GitHub username only (do not include `@`).
- `<YOUR-PROFILE-NAME>` with your AWS CLI profile name.

<details>
<summary>macOS</summary>

```bash
aws ssm put-parameter \
    --name "laigo-owner-name" \
    --value "<YOUR-GITHUB-USERNAME>" \
    --type String \
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>Windows CMD</summary>

```cmd
aws ssm put-parameter ^
    --name "laigo-owner-name" ^
    --value "<YOUR-GITHUB-USERNAME>" ^
    --type String ^
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
aws ssm put-parameter `
    --name "laigo-owner-name" `
    --value "<YOUR-GITHUB-USERNAME>" `
    --type String `
    --profile <YOUR-PROFILE-NAME>
```

</details>

#### 3) Database bootstrap secret (required by Database stack)

Create a secret named `LAIGOSecrets` with JSON key `DB_Username`.

Before running the command, replace:

- `<YOUR-DB-USERNAME>` with the database admin username you want to use for this deployment. See [RDS Master Username Constraints](#rds-master-username-constraints) for naming rules.
- `<YOUR-PROFILE-NAME>` with your AWS CLI profile name.

<details>
<summary>macOS</summary>

```bash

aws secretsmanager create-secret \
    --name LAIGOSecrets \
    --secret-string "{\"DB_Username\":\"<YOUR-DB-USERNAME>\"}" \
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>Windows CMD</summary>

```cmd
aws secretsmanager create-secret ^
    --name LAIGOSecrets ^
    --secret-string "{\"DB_Username\":\"<YOUR-DB-USERNAME>\"}" ^
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
aws secretsmanager create-secret `
    --name LAIGOSecrets `
    --secret-string '{\"DB_Username\":\"<YOUR-DB-USERNAME>\"}' `
    --profile <YOUR-PROFILE-NAME>
```

</details>

For example:

```bash
aws secretsmanager create-secret \
    --name LAIGOSecrets \
    --secret-string "{\"DB_Username\":\"LAIGODatabaseUser\"}" \
    --profile <YOUR-PROFILE-NAME>
```

#### 4) Allowed signup domains (required by Cognito pre-signup Lambda)

Create secure SSM parameter `/LAIGO/AllowedEmailDomains` with a comma-separated domain list.

Before running the command, replace:

- `<YOUR-ALLOWED-EMAIL-DOMAIN-LIST>` with a comma-separated list like `example.com,school.edu`.
- `<YOUR-PROFILE-NAME>` with your AWS CLI profile name.

<details>
<summary>macOS</summary>

```bash
aws ssm put-parameter \
    --name "/LAIGO/AllowedEmailDomains" \
    --value "<YOUR-ALLOWED-EMAIL-DOMAIN-LIST>" \
    --type SecureString \
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>Windows CMD</summary>

```cmd
aws ssm put-parameter ^
    --name "/LAIGO/AllowedEmailDomains" ^
    --value "<YOUR-ALLOWED-EMAIL-DOMAIN-LIST>" ^
    --type SecureString ^
    --profile <YOUR-PROFILE-NAME>
```

</details>

<details>
<summary>PowerShell</summary>

```powershell
aws ssm put-parameter `
    --name "/LAIGO/AllowedEmailDomains" `
    --value "<YOUR-ALLOWED-EMAIL-DOMAIN-LIST>" `
    --type SecureString `
    --profile <YOUR-PROFILE-NAME>
```

</details>

Example:

```bash
aws ssm put-parameter \
    --name "/LAIGO/AllowedEmailDomains" \
    --value "ubc.ca,student.ubc.ca,allard.ubc.ca,amazon.com" \
    --type SecureString \
    --profile <YOUR-PROFILE-NAME>
```

### Step 3: CDK Deployment

It's time to set up everything that goes on behind the scenes. For more detail on the backend architecture, see the [Architecture Deep Dive](architectureDeepDive.md), but backend knowledge is not required for deployment.

Open a terminal in the `cdk/` directory.

#### 3.1 Download requirements

Install requirements with npm:

```bash
npm install
```

#### 3.2 Initialize the CDK stack (only if needed)

Run this only if you have not deployed resources with CDK in this account/region before (or us-east-1).

Replace:

- `<YOUR-PROFILE-NAME>` with the AWS CLI profile used earlier.
- `<YOUR_AWS_ACCOUNT_ID>` with your AWS account ID.
- `<YOUR_PRIMARY_REGION>` with your primary deployment region.
- `<YOUR-STACK-PREFIX>` with your stack prefix.

Run synth:

```bash
cdk synth --all --context StackPrefix="<YOUR-STACK-PREFIX>" --context GithubRepo="LAIGO" --profile <YOUR-PROFILE-NAME>
```

Bootstrap your primary region:

```bash
npx cdk bootstrap aws://<YOUR_AWS_ACCOUNT_ID>/<YOUR_PRIMARY_REGION> --context StackPrefix="<YOUR-STACK-PREFIX>" --context GithubRepo="LAIGO" --profile <YOUR-PROFILE-NAME>
```

Bootstrap `us-east-1`:

```bash
npx cdk bootstrap aws://<YOUR_AWS_ACCOUNT_ID>/us-east-1 --context StackPrefix="<YOUR-STACK-PREFIX>" --context GithubRepo="LAIGO" --profile <YOUR-PROFILE-NAME>
```

#### 3.3 Choose your deployment options

LAIGO supports two optional context parameters that can be combined independently. Read the descriptions below and pick the deploy command that matches your needs.

| Parameter | Purpose | When to use |
|---|---|---|
| `DomainName` | Custom frontend domain and CORS lockdown | You want a branded URL and tighter API security |
| `SesVerifiedDomain` | SES-based email for Cognito | You need more than ~50 sign-ups/day, or want branded sender emails |

See the [Requirements](#requirements) section for full details and prerequisites for each option.

#### 3.4 Deploy CDK stacks

Deploy all stacks using the command that matches your setup. Replace:

- `<YOUR-PROFILE-NAME>` with the AWS CLI profile used earlier.
- `<YOUR-STACK-PREFIX>` with your stack prefix.

The stack prefix is added to physical resource names. `Environment` specifies the deployment environment (`dev`, `test`, `prod`), and `Version` specifies the application version.

**Option A: No custom domain, no SES (simplest)**

Uses the default Amplify domain, wildcard CORS, and Cognito's built-in email service. Good for development, testing, or small deployments.

```bash
npx cdk deploy --all \
    --context StackPrefix=<YOUR-STACK-PREFIX> \
    --context Environment=dev \
    --context Version=1.2.0 \
    --context GithubRepo="LAIGO" \
    --profile <YOUR-PROFILE-NAME>
```

**Option B: Custom domain only (no SES)**

Serves the frontend on your domain and locks down CORS. Cognito still uses its built-in email service (50 emails/day limit). Good for production deployments with a small user base.

```bash
npx cdk deploy --all \
    --context StackPrefix=<YOUR-STACK-PREFIX> \
    --context Environment=dev \
    --context Version=1.2.0 \
    --context GithubRepo="LAIGO" \
    --context DomainName="app.example.com" \
    --profile <YOUR-PROFILE-NAME>
```

**Option C: SES email only (no custom domain)**

Uses the default Amplify domain but sends Cognito emails through SES. Good when you need higher email throughput but don't have a custom domain ready yet.

```bash
npx cdk deploy --all \
    --context StackPrefix=<YOUR-STACK-PREFIX> \
    --context Environment=dev \
    --context Version=1.2.0 \
    --context GithubRepo="LAIGO" \
    --context SesVerifiedDomain="example.com" \
    --profile <YOUR-PROFILE-NAME>
```

**Option D: Custom domain + SES email (full setup)**

Serves the frontend on your domain, locks down CORS, and sends emails through SES. The two domains can be the same or different. Recommended for production.

```bash
npx cdk deploy --all \
    --context StackPrefix=<YOUR-STACK-PREFIX> \
    --context Environment=dev \
    --context Version=1.2.0 \
    --context GithubRepo="LAIGO" \
    --context DomainName="app.example.com" \
    --context SesVerifiedDomain="example.com" \
    --profile <YOUR-PROFILE-NAME>
```

If you have trouble running the commands with `\`, remove the line breaks and run it as one line.

Example:

```bash
npx cdk deploy --all --context StackPrefix="LAIGO" --context Environment=dev --context Version=1.2.0 --context GithubRepo="LAIGO" --profile <YOUR-PROFILE-NAME>
```

## Post-Deployment

### Step 1: Verify Bedrock Model Access

Anthropic models on Bedrock may require a use-case request before access is granted. To check:

1. In the AWS Console, navigate to Amazon Bedrock > Playgrounds > Chat playground.
2. Select an Anthropic model (e.g. `Claude Sonnet 5`) and try sending a message.
3. If a use-case form appears, fill it out and submit. Wait approximately 15 minutes for approval before using the application.
4. If you can chat with the model without any prompts, you may continue.

### Step 2: Request SES Production Access (if using SesVerifiedDomain)

If you deployed with `--context SesVerifiedDomain=...`, Cognito email verification is sent through SES. New AWS accounts are often in SES sandbox mode, which only allows sending to verified recipients.

1. In the AWS Console, open **Support Center** and create a case to request SES production access for your deployment region. For detailed steps, see [Request production access (Moving out of the Amazon SES sandbox)](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
2. Wait for AWS approval before expecting sign-up verification emails to be delivered to unverified recipients.
3. If you did not set `SesVerifiedDomain` during deployment, skip this step — Cognito's built-in email service does not require SES production access.

### Step 3: Build AWS Amplify App

1. Log in to AWS console, and navigate to AWS Amplify. You can do so by typing Amplify in the search bar at the top.
2. From All apps, click `<stack-prefix>-Amplify-admin`.
3. Then click `main` under branches.
4. Click **Run job** and wait for the build to complete.
5. You now have access to the Amplify App ID and the public domain name to use the web app.

### Step 4: Visit Web App

You can now navigate to the web app URL to see your application in action.

## Cleanup

### Taking down the deployed stack

To take down the deployed stack for a fresh redeployment in the future, navigate to AWS CloudFormation on the AWS Console, click on the stack and hit Delete.

Please wait for the stacks in each step to be properly deleted before deleting the stack downstream.

Also make sure to delete secrets in Secrets Manager.

## Troubleshooting

### Stack Deletion

Sometimes stack deletion can fail. If you encounter issues while taking down your stacks:

1. **Aurora Database**: disable delete protection in Aurora for the database before attempting stack deletion, specifically when deleting the Database stack.
2. **ECR Repository**: ensure that nothing is present in ECR (Elastic Container Registry). Sometimes the stacks fail deletion due to remaining container images.
3. **Manual Cleanup**: if stacks continue to fail deletion, you may need to manually delete resources from ECR and other services before retrying the stack deletion.

### RDS Master Username Constraints

If the Database stack fails to create with an error related to the master username, your `DB_Username` value in the `LAIGOSecrets` secret may not meet RDS requirements. For PostgreSQL, the master username must:

- Start with a letter
- Contain only alphanumeric characters and underscores (`_`)
- Be 1–63 characters long
- Not be a PostgreSQL reserved word (e.g. `admin`, `postgres`, `rds_superuser`, `public`)

Hyphens, spaces, periods, and other special characters are not allowed. Valid examples: `dbadmin`, `app_admin`, `laigodb`.

To fix this, update the secret value in Secrets Manager with a valid username and redeploy.
