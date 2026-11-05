# LAIGO Frontend

React 19 + TypeScript single-page app built with Vite. The UI uses MUI and Tailwind CSS 4, authenticates with AWS Amplify (Cognito), and calls the LAIGO REST and WebSocket APIs. The React Compiler is enabled through `babel-plugin-react-compiler` in `vite.config.ts`.

## Scripts

- `npm run dev`: start the Vite dev server on `http://localhost:5173`
- `npm run build`: type-check with `tsc -b` and build to `dist/`
- `npm run lint`: run ESLint
- `npm run preview`: serve the production build locally

## Local development

Create `frontend/.env` with the values from your deployment (do not commit it):

```
VITE_API_ENDPOINT=http://localhost:5173/api
VITE_API_PROXY_TARGET=https://<api-id>.execute-api.<region>.amazonaws.com/prod
VITE_COGNITO_USER_POOL_ID=<user-pool-id>
VITE_COGNITO_USER_POOL_CLIENT_ID=<client-id>
VITE_IDENTITY_POOL_ID=<identity-pool-id>
VITE_AWS_REGION=<region>
VITE_WEBSOCKET_URL=wss://<websocket-api-id>.execute-api.<region>.amazonaws.com/prod
```

The Vite dev server proxies `/api` requests to `VITE_API_PROXY_TARGET`, so the browser sees them as same-origin. See [Setting Up Local Development](../docs/modificationGuide.md#setting-up-local-development) for details.

In deployed environments, Amplify injects these variables at build time (see `cdk/lib/amplify-stack.ts`).
