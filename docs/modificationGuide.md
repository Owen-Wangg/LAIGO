# Project Modification Guide

This guide provides instructions on how to modify and extend the project.

## Modifying Colors and Styles

The `frontend` folder contains `frontend/src/index.css`, which defines the global theme tokens used throughout the app (via CSS variables and component styles).

Two configurations exist; one for light mode and one for dark mode. Changing variables in the first `:root` updates light mode, while variables inside `@media (prefers-color-scheme: dark) { :root { ... } }` update dark mode.

_Note: the UI theme is synced to your OS theme. If your system is in light mode, the site renders in light mode; if your system is in dark mode, the site renders in dark mode._

Frontend implementation details:

- Global styles and tokens are in `frontend/src/index.css`.
- Route-level layout and auth bootstrap are in `frontend/src/App.tsx`.
- Most UI pages live in `frontend/src/pages/**` (for example `Case/`, `Admin/`, `Supervisor/`, `Advocate/`).
- Shared reusable UI blocks are in `frontend/src/components/**`.
- Shared API helpers are in `frontend/src/services/**` and shared state is in `frontend/src/contexts/**`.

```css
/* Filepath: ./frontend/src/index.css */
:root {
  --text: #050315;
  --text-secondary: #6e6e6e;
  --text-button: #f0f0f0;
  --background: #ffffff;
  --background2: #f5f5f5;
  --background3: #d4dbdf;
  --header: #ffffff;
  --header-text: --primary;
  --primary: #111835;
  --secondary: oklch(from var(--primary) calc(l * 1.5) c h);;
  --accent: #1c187a;
  --bot-text: --background;
  --sender-text: #f0f0f0;
  --input: #c4c4c4;
  --placeholder-text: #696873;
  --green-text: #2e9832;
  --border: #cccccc;
  --feedback: #3b58ff;

  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;

  color-scheme: light dark;
  color: #213547;
  background-color: #ffffff;


  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

@media (prefers-color-scheme: dark) {
  :root {
    --text: #ffffff;
    --text-secondary: #aaaaaa;
    --green-text: #65ff6a;
    --text-button: #0e0e0e;
    --background: #2c2c2c;
    --background2: #171717;
    --background3: #444444;
    --header: #171717;
    --header-text: #ffffff;
    --primary: #537ece;
    --secondary: #466ec4;
    --accent: #3949ff;
    --bot-text: --background;
    --sender-text: #424141;
    --input: #5c5c5c;
    --placeholder-text: #8e8e8e;
    --border: #5c5c5c;
    --feedback: #769aff;

    color: var(--text);
    background-color: var(--background);
  }
```

## Setting Up Local Development

### Overview

Local development uses a Vite proxy to avoid CORS issues when running the frontend on `localhost:5173`. The proxy intercepts API requests and forwards them to the deployed API Gateway endpoint, making requests appear same-origin to the browser.

**Important**: The proxy only affects local development (`npm run dev`). Production builds deployed via Amplify are unaffected and use the actual API endpoint directly.

### Configuration

1. **Create `.env` file in the `frontend/` directory**:

   ```bash
   cd frontend
   touch .env
   ```

2. **Add the following environment variables to `frontend/.env`**:

   ```
   VITE_API_ENDPOINT=http://localhost:5173/api
   VITE_API_PROXY_TARGET=https://your-api-endpoint.execute-api.region.amazonaws.com/prod
   VITE_COGNITO_USER_POOL_ID=your-user-pool-id
   VITE_COGNITO_USER_POOL_CLIENT_ID=your-client-id
   VITE_IDENTITY_POOL_ID=your-identity-pool-id
   VITE_AWS_REGION=your-region
   VITE_WEBSOCKET_URL=wss://your-websocket-endpoint.execute-api.region.amazonaws.com/prod
   ```

   Replace the placeholder values with your actual AWS resources from your deployment.

3. **Ensure `.env` is gitignored**:

   The `.env` file is already in `.gitignore` and should not be committed. Each developer configures their own local `.env` file.

### How It Works

- `VITE_API_ENDPOINT` is used by frontend code to make API requests to `http://localhost:5173/api`
- Vite's dev server intercepts these requests and proxies them to `VITE_API_PROXY_TARGET` (your actual API Gateway endpoint)
- The proxy rewrites the request path, removing the `/api` prefix before forwarding
- To the browser, all requests appear same-origin, eliminating CORS preflight issues
- Backend CORS configuration is not affected by the proxy

### Making API Requests

In your frontend code, use the `VITE_API_ENDPOINT` environment variable:

```typescript
const response = await fetch(
  `${import.meta.env.VITE_API_ENDPOINT}/student/profile`,
  {
    headers: {
      Authorization: token,
    },
  }
);
```

### Production Deployment

When deploying to production via Amplify:

- Amplify uses the `VITE_API_ENDPOINT` environment variable configured in `cdk/lib/amplify-stack.ts`
- This is set to the actual API Gateway endpoint (e.g., `https://your-api.execute-api.region.amazonaws.com/prod`)
- No proxy is needed because the API returns CORS headers for the configured frontend origin (`DomainName` or `FrontendOrigin`; see the [Deployment Guide](./deploymentGuide.md#custom-domain-optional))
- The `VITE_API_PROXY_TARGET` variable is only used locally and is not deployed

### Troubleshooting

**Still getting CORS errors?**
- Verify `VITE_API_PROXY_TARGET` points to your actual API Gateway endpoint
- Check that the endpoint URL is correct (should start with `https://`)
- Restart the dev server after changing `.env` variables

**API requests returning 500 errors?**
- Verify your AWS credentials are configured (via AWS CLI or environment variables)
- Check that the API endpoint is deployed and accessible
- Review CloudWatch logs for the Lambda functions

**WebSocket not connecting?**
- Verify `VITE_WEBSOCKET_URL` is correct (should start with `wss://`)
- WebSocket connections bypass the Vite proxy and connect directly to the endpoint
- Ensure your JWT token is valid and not expired

## Customizing the Verification Email

### Modifying Visual Aspects

To modify the user verification email on sign-up, navigate to `cdk/lib/api-stack.ts`, and look for `this.userPool = new cognito.UserPool(...)`. A few lines below, the verification email appearance is configured in HTML.

To update the template, modify the `emailBody` attribute inside `userVerification`.

Backend notes:

- Subject line is controlled by `userVerification.emailSubject`.
- Verification code placeholder must remain `{####}` for Cognito code delivery.
- Authentication policy details in this same block (`passwordPolicy`, `autoVerify`, recovery options) impact user sign-up/login behavior across frontend and backend.
- After editing this block, redeploy CDK so Cognito updates are applied.

For reference, an abridged version of the code is shown below (CSS omitted). The file in `cdk/lib/api-stack.ts` is the source of truth.

```javascript
const userPoolName = `${id}-UserPool`;
this.userPool = new cognito.UserPool(this, `${id}-pool`, {
  userPoolName: userPoolName,
  signInAliases: {
    email: true,
  },
  selfSignUpEnabled: true,
  autoVerify: {
    email: true,
  },
  userVerification: {
    emailSubject: "LAIGO AI Assistant - Verify your email",
    emailBody: `
    <html>
      <head>
        <style>
          /* body, .email-container, .header, .main-content, .code, .footer styles */
        </style>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600&display=swap" rel="stylesheet">
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <h1>LAIGO AI Assistant</h1>
          </div>
          <div class="main-content">
            <p>Thank you for signing up for LAIGO AI Assistant!</p>
            <p>Verify your email by using the code below:</p>
            <div class="code">{####}</div>
            <p>If you did not request this verification, please ignore this email.</p>
          </div>
          <div class="footer">
            <p>Please do not reply to this email.</p>
            <p>LAIGO AI Assistants, 2025</p>
          </div>
        </div>
      </body>
    </html>
          `,
    emailStyle: cognito.VerificationEmailStyle.CODE,
  },
  passwordPolicy: {
    minLength: 12,
    requireLowercase: true,
    requireUppercase: true,
    requireDigits: true,
    requireSymbols: true,
  },
  email: emailConfig, // SES when SesVerifiedDomain is set, otherwise Cognito's built-in sender
  accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});
```

If you change `passwordPolicy`, update the matching password checks in the frontend sign-up form (`frontend/src/pages/Login.tsx`) so users see the same rules.

## Extending the API

### Adding New Endpoints

To add a new REST API endpoint, follow these steps:

1. Add the Lambda handler code in `cdk/lambda/handlers/<your-handler>.js` or `cdk/lambda/<functionName>/src/main.py` depending on runtime.
2. Add a new function resource in `cdk/lib/api-stack.ts` (for example `lambda.Function` or `lambda.DockerImageFunction`).
3. Add or update the Lambda permissions and integration references in `cdk/lib/api-stack.ts` as needed.
4. Modify `cdk/OpenAPI_Swagger_Definition.yaml` to reflect the new endpoint.
5. Run `cdk deploy` to deploy the change.

Make changes to these steps as required for the specific endpoint.

Example (`NodeJS` lambda):

```typescript
const myHandler = new lambda.Function(this, `${id}-MyHandler`, {
  runtime: lambda.Runtime.NODEJS_24_X,
  code: lambda.Code.fromAsset("lambda/handlers"),
  handler: "myHandler.handler",
  timeout: Duration.seconds(29),
  vpc: vpcStack.vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  securityGroups: [dbClientSg], // required to reach the RDS Proxy
  environment: {
    SM_DB_CREDENTIALS: db.secretPathUser.secretName,
    RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
    ...corsEnv, // ALLOWED_ORIGIN for CORS response headers
  },
  layers: [postgres, javascriptPowertoolsLayer],
  role: myHandlerRole, // dedicated least-privilege role; grant only what the handler needs
});
db.secretPathUser.grantRead(myHandler);

const cfnMyHandler = myHandler.node.defaultChild as lambda.CfnFunction;
cfnMyHandler.overrideLogicalId("myHandler");
```

Then update `cdk/OpenAPI_Swagger_Definition.yaml` to add the endpoint, attach the matching authorizer (`adminAuthorizer`, `instructorAuthorizer`, or `studentAuthorizer`) under `security`, and point `x-amazon-apigateway-integration` at the Lambda logical id. Also grant API Gateway permission to invoke the function (`myHandler.addPermission(...)`), following the existing handlers.

Note: The project has existing handlers under `cdk/lambda/handlers/` such as `adminFunction.js`, `studentFunction.js`, and `instructorFunction.js` which can serve as examples for patterns to follow.

## Modifying Frontend Text, Icons, and Logo

1. **Locate Components**:

   - For the main application UI, update components in `frontend/src/components`.
   - For the main pages, update the files in `frontend/src/pages`.

2. **Modify Logo/Icon Asset**: To change the icon used by the app, navigate to `frontend/public/` and replace `favicon.svg`.

3. **Modify Browser Tab Icon**: The browser tab icon is configured in `frontend/index.html` via `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`. Replacing `frontend/public/favicon.svg` updates this icon.

4. **Modify Text and UI Icons**: Update specific text and icon configurations in each component file. Each component has its unique structure, so locate the relevant text or icon section within the component and make your changes.

For example, to alter the interview assistant page, modify `frontend/src/pages/Case/InterviewAssistant.tsx`.

After making the required changes in the fork created in the [Deployment Guide](./deploymentGuide.md), commit and push those changes to the branch connected to Amplify. Once the changes are pushed, the Amplify deployment should automatically redeploy.

## Modifying the LLM

- **Change the active model**:

  - To change the currently active model between the options already available in the application, use the admin **Settings** page (**General Configs** tab). See the [User Guide](./userGuide.md) for the admin UI workflow.

- **Change the available models**:

  - The model options shown in the admin UI come from the `defaultBedrockModelOptions` array in `cdk/lib/api-stack.ts`. CDK writes it to the SSM parameter `/<StackPrefix>-ApiStack/LAIGO/BedrockModelOptions`, which `GET /admin/ai_config` returns. Each entry has a `label`, a `value` (model ID or inference profile ARN), and `constraints` (`maxOutputTokens`, `defaultMaxOutputTokens`, `temperatureRange`, `topPRange`) that the admin API and the prompt playground enforce.
  - Add or edit an entry there and redeploy. `frontend/src/components/Admin/ModelConfig.tsx` has a `FALLBACK_MODEL_OPTIONS` list that is only used when the API returns no options; keep it in sync if you rely on it.
  - The backend Lambdas build Bedrock request bodies for Anthropic and Meta models only. A model from another provider also needs request/response handling in the Python Lambdas.
  - Update the allowed Bedrock model permissions in `cdk/lib/api-stack.ts` so the application can invoke the model.
  - A list of the available Bedrock models and their IDs is listed [here](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html).
  - The `bedrockPolicyStatement` currently allows Anthropic and Meta foundation models and their `us.` cross-region inference profiles:

  ```typescript
  const bedrockPolicyStatement = new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    resources: [
      `arn:aws:bedrock:${this.region}::foundation-model/anthropic.*`,
      `arn:aws:bedrock:${this.region}::foundation-model/meta.*`,
      `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.*`,
      `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.meta.*`,
      // A "us." inference profile routes to foundation models in these regions
      ...["us-east-1", "us-east-2", "us-west-2"].flatMap((r) => [
        `arn:aws:bedrock:${r}::foundation-model/anthropic.*`,
        `arn:aws:bedrock:${r}::foundation-model/meta.*`,
      ]),
    ],
  });
  ```

  - **Foundation models** (e.g., `meta.llama3-70b-instruct-v1:0`) use the `foundation-model` ARN pattern.
  - **Cross-region inference profiles** (e.g., `us.anthropic.claude-sonnet-5-5`) use the `inference-profile` ARN pattern and allow Bedrock to route requests across regions for improved availability. Invoking a profile also requires permission on the foundation models in every region the profile routes to.

  - After making these changes, redeploy the application by using the `cdk deploy` command in the deployment guide.

  - If you update generation behavior beyond model selection, review Python Lambda prompt/orchestration logic in:

    - `cdk/lambda/text_generation/src/helpers/chat.py`
    - `cdk/lambda/playground_generation/src/helpers/chat.py`
    - `cdk/lambda/*/src/main.py` entrypoints where model/config parameters are consumed.

  - **Reasoning, assessment, and summary prompts** (including the full-case synthesis prompt) are managed from the admin **Settings** page and stored in the `prompt_versions` table. Update these through the UI. Default versions are seeded by migration `004_seed_default_system_prompts.js`.
  - The legal disclaimer appended to every summary is hardcoded as `DISCLAIMER` in `cdk/lambda/summary_generation/src/main.py`.
