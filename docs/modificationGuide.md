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
- No proxy is needed because Amplify serves the frontend from your custom domain, making requests same-origin
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

For reference, the full code is shown below (as it is at the time this documentation was written).

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
    emailSubject: "Legal Aid Tool - Confirmation Code",
    emailBody: `
    <html>
      <head>
        <style>
          body {
            font-family: Outfit, sans-serif;
            background-color: #F5F5F5;
            color: #111835;
            margin: 0;
            padding: 0;
            font-size: 16px;
          }
          .email-container {
            background-color: #ffffff;
            width: 100%;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            border-radius: 8px;
            border: 1px solid #ddd;
          }
          .header {
            text-align: center;
            margin-bottom: 20px;
          }
          .header img {
            width: 100px;
            height: auto;
          }
          .main-content {
            text-align: center;
            font-size: 18px;
            color: #444;
            margin-bottom: 30px;
          }
          .code {
            display: inline-block;
            background-color: #111835;
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            padding: 15px 25px;
            border-radius: 4px;
            margin-top: 20px;
            margin-bottom: 20px;
          }
          .footer {
            text-align: center;
            font-size: 14px;
            color: #888;
          }
          .footer a {
            color: #546bdf;
            text-decoration: none;
          }
        </style>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600&display=swap" rel="stylesheet">
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <h1>Legal Aid Tool</h1>
            <!--<img src="" alt="Legal Aid Tool Logo" width="150" height="auto"/>-->
          </div>
          <div class="main-content">
            <p>Thank you for signing up for Legal Aid Tool!</p>
            <p>Verify your email by using the code below:</p>
            <div class="code">{####}</div>
            <p>If you did not request this verification, please ignore this email.</p>
          </div>
          <div class="footer">
            <p>Please do not reply to this email.</p>
            <p>Legal Aid Tool, 2025</p>
          </div>
        </div>
      </body>
    </html>
          `,
    emailStyle: cognito.VerificationEmailStyle.CODE,
  },
  passwordPolicy: {
    minLength: 8,
    requireLowercase: true,
    requireUppercase: true,
    requireDigits: true,
    requireSymbols: false,
  },
  accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
```

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
  code: lambda.Code.fromAsset("lambda"),
  handler: "handlers/myHandler.handler",
  environment: {
    SM_DB_CREDENTIALS: db.secretPathUser.secretName,
    RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
  },
});

const cfnMyHandler = myHandler.node.defaultChild as lambda.CfnFunction;
cfnMyHandler.overrideLogicalId("myHandler");
```

Then update `cdk/OpenAPI_Swagger_Definition.yaml` to add the endpoint and point `x-amazon-apigateway-integration` at the Lambda logical id.

Note: The project has existing handlers under `cdk/lambda/handlers/` such as `adminFunction.js`, `studentFunction.js`, and `instructorFunction.js` which can serve as examples for patterns to follow.

## Modifying Frontend Text, Icons, and Logo

1. **Locate Components**:

   - For the main application UI, update components in `frontend/src/components`.
   - For the main pages, update the files in `frontend/src/pages`.

2. **Modify Logo/Icon Asset**: To change the icon used by the app, navigate to `frontend/public/` and replace `favicon.svg`.

3. **Modify Browser Tab Icon**: The browser tab icon is configured in `frontend/index.html` via `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`. Replacing `frontend/public/favicon.svg` updates this icon.

4. **Modify Text and UI Icons**: Update specific text and icon configurations in each component file. Each component has its unique structure, so locate the relevant text or icon section within the component and make your changes.

For example, to alter the interview assistant page, modify `frontend/src/pages/Case/InterviewAssistant.tsx`.

After making the required changes in the fork created in the [Deployment Guide](./docs/deploymentGuide.md), commit and push those changes to the branch connected to Amplify. Once the changes are pushed, the Amplify deployment should automatically redeploy.

## Modifying the LLM

- **Change the active model**:

  - To change the currently active model between the options already available in the application, use the admin "AI Settings" page. See the [User Guide](./userGuide.md) for the admin UI workflow.

- **Change the available models**:

  - To change which model options are available in the admin UI, you will need to modify the codebase and redeploy.
  - Update the allowed Bedrock model permissions in `cdk/lib/api-stack.ts` so the application can invoke the model.
  - Update the frontend admin model option list so the model appears in the "AI Settings" page.
  - A list of the available Bedrock models and their IDs is listed [here](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html).
  - The `bedrockPolicyStatement` currently allows both foundation models and cross-region inference profiles:

  ```typescript
  const bedrockPolicyStatement = new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    resources: [
      `arn:aws:bedrock:${this.region}::foundation-model/*`,
      `arn:aws:bedrock:*::inference-profile/*`,
    ],
  });
  ```

  - **Foundation models** (e.g., `meta.llama3-70b-instruct-v1:0`) use the `foundation-model` ARN pattern.
  - **Cross-region inference profiles** (e.g., `us.anthropic.claude-sonnet-5-5`) use the `inference-profile` ARN pattern and allow Bedrock to route requests across regions for improved availability.

  - After making these changes, redeploy the application by using the `cdk deploy` command in the deployment guide.

  - If you update generation behavior beyond model selection, review Python Lambda prompt/orchestration logic in:

    - `cdk/lambda/text_generation/src/helpers/chat.py`
    - `cdk/lambda/playground_generation/src/helpers/chat.py`
    - `cdk/lambda/*/src/main.py` entrypoints where model/config parameters are consumed.

  - **Reasoning and assessment prompts** are managed from the admin "AI Settings" page and stored in RDS (for example in `prompt_versions`). Update these through the UI.
  - **Summary-generation prompts** are currently hardcoded in the summary Lambda and are not currently exposed in the admin UI. Update these in `cdk/lambda/summary_generation/src/helpers/chat.py`.
