# Security Review: Authentication, Authorization & Session Management

**Document:** `docs/code-reviews/code-review-authentication.md`
**Status:** Complete
**Last Updated:** 2025-07-22
**Scope:** Cognito User Pool, Lambda Authorizers, RBAC, Token Lifecycle, WebSocket Auth, Cognito Triggers, Identity Pool, Frontend Session Management

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Cognito User Pool Assessment](#2-cognito-user-pool-assessment)
3. [Lambda Authorizer Assessment](#3-lambda-authorizer-assessment)
4. [Role-Based Access Control (RBAC) Assessment](#4-role-based-access-control-rbac-assessment)
5. [Token Lifecycle Assessment](#5-token-lifecycle-assessment)
6. [WebSocket Authentication Assessment](#6-websocket-authentication-assessment)
7. [Cognito Triggers Assessment](#7-cognito-triggers-assessment)
8. [Identity Pool Assessment](#8-identity-pool-assessment)
9. [Frontend Session Management Assessment](#9-frontend-session-management-assessment)
10. [Consolidated Findings from Existing Reviews](#10-consolidated-findings-from-existing-reviews)
11. [OWASP Compliance Mapping](#11-owasp-compliance-mapping)
12. [Remediation Priority Matrix](#12-remediation-priority-matrix)

---

## Finding ID Convention

New findings use the prefix `AUTH-` followed by a domain code and sequential number:

| Domain | Code | Example | Description |
|--------|------|---------|-------------|
| Cognito User Pool | `CUP` | AUTH-CUP-01 | User Pool configuration, password policy, MFA, auth flows |
| Lambda Authorizer | `LA` | AUTH-LA-01 | JWT verification, role enforcement, caching, error handling |
| RBAC | `RBAC` | AUTH-RBAC-01 | Role model, enforcement chain, privilege escalation |
| Token Lifecycle | `TL` | AUTH-TL-01 | Token TTL, refresh rotation, session invalidation, logout |
| WebSocket | `WS` | AUTH-WS-01 | WS authorizer, token extraction, connection lifecycle |
| Cognito Triggers | `CT` | AUTH-CT-01 | Pre-signup validation, post-confirmation provisioning |
| Identity Pool | `IP` | AUTH-IP-01 | Federated credentials, IAM role scope, role mapping |
| Frontend Session | `FS` | AUTH-FS-01 | Token storage, XSS/CSRF, session termination, login page |

Consolidated findings from existing review documents retain their original IDs (e.g., `S-H3`, `Node-H3`) with cross-references to the relevant AUTH-prefixed assessment section.

---

## Severity Scale

| Level | Definition |
|-------|------------|
| **Critical** | Actively exploitable vulnerability that could lead to unauthorized access, data breach, or privilege escalation with minimal attacker effort |
| **High** | Security gap that significantly increases attack surface or weakens a critical control, exploitable under realistic conditions |
| **Medium** | Security weakness that requires specific conditions or chained exploits to impact confidentiality/integrity/availability |
| **Low** | Hardening opportunity or best-practice deviation with limited direct security impact |

## Effort-to-Fix Scale

| Level | Definition |
|-------|------------|
| **Low** | Configuration change only, less than 1 day, no code deployment required |
| **Medium** | Code or infrastructure change, 1–5 days, requires testing and deployment |
| **High** | Architectural change, more than 5 days, may require design review and phased rollout |

---

## 1. Executive Summary

### Overall Authentication Posture

The LAIGO platform implements a **multi-layered authentication and authorization architecture** that demonstrates strong foundational design: Cognito-managed identity, parameterized database queries (eliminating SQL injection), consistent authorizer error handling, robust BOLA (Broken Object Level Authorization) protections, and session-scoped token storage. The security team has addressed 43% of previously identified authentication findings, and the core authorization flow (JWT → database role lookup → handler BOLA check) is architecturally sound.

However, the platform exhibits **critical gaps in defense-in-depth controls** — particularly MFA enforcement, Content Security Policy, and token lifecycle management — that are inappropriate for a system handling solicitor-client privileged legal content in a Canadian legal education context. The absence of MFA for admin and instructor roles, combined with a 30-day refresh token window and local-only logout, means that a single compromised credential provides extended, unrevokable access to privileged legal communications.

**Overall Risk Rating: HIGH** — The platform's core authorization logic is well-implemented, but surrounding controls (MFA, CSP, session lifecycle, WebSocket re-authentication) have gaps that increase the blast radius and duration of credential compromise.

### Key Strengths

- **Strong BOLA protections:** Handler-level authorization (`authorizeCaseAccess`, `authorizeObjectAccess`) consistently validates object ownership using trusted authorizer-provided identity — horizontal privilege escalation risk is low across all endpoints
- **Robust JWT validation:** `aws-jwt-verify` with signature, expiration, issuer, and audience verification on all four authorizers; consistent `"Unauthorized"` error responses with no information leakage to clients
- **Session storage choice:** Frontend uses `sessionStorage` (cleared on tab close) rather than `localStorage`, limiting the persistence window for stolen tokens
- **API surface coverage:** Every functional endpoint (REST and WebSocket) is protected by a role-appropriate Lambda authorizer; no unauthenticated endpoints exist beyond OPTIONS preflight
- **Database as authoritative role source:** Role enforcement queries the database on each non-cached invocation (not JWT claims), enabling immediate role revocation propagation (within 60-second cache window)

### Critical Gaps Requiring Immediate Attention

| Priority | Gap | Finding IDs | Risk | Sprint |
|----------|-----|-------------|------|--------|
| 1 | **MFA disabled for all roles** — Admin accounts with full platform control use single-factor authentication | AUTH-CUP-01 | Credential compromise = full platform compromise with no second factor challenge | Immediate |
| 2 | **No Advanced Security Features** — No breached password detection, no adaptive authentication, no risk-based challenges | AUTH-CUP-02, AUTH-CUP-05 | Users with passwords from public breaches authenticate without intervention; no detection of anomalous sign-in patterns | Immediate |
| 3 | **30-day refresh token lifetime** — Stolen refresh tokens provide month-long persistent access | AUTH-TL-01 | Extended access window vastly exceeds session risk tolerance for privileged legal content | Immediate |
| 4 | **Local-only logout** — Tokens not revoked server-side; captured tokens remain valid post-logout | AUTH-TL-02 | Attacker with captured refresh token retains access even after user logs out | Immediate |
| 5 | **WebSocket credential leakage** — JWT exposed via URL query parameter and echoed in response headers | AUTH-WS-01, AUTH-WS-04 | Token exposure in logs, browser history, and intermediary proxies; doubles attack surface for credential capture | Immediate |
| 6 | **No WebSocket WAF protection** — DDoS, credential stuffing, and IP reputation filtering absent | AUTH-WS-02 | WebSocket API unprotected against attacks that REST API WAF mitigates; 100 connection attempts/second with no per-IP limiting | Immediate |
| 7 | **First-user-admin race condition** — Concurrent signups can both receive admin role | AUTH-CT-01, AUTH-RBAC-02 | Unauthorized admin assignment during deployment; TOCTOU vulnerability with no lock or transaction | Next Sprint |
| 8 | **No production CSP** — XSS has no browser-level restriction; `unsafe-inline`/`unsafe-eval` in script-src | AUTH-TL-04, AUTH-FS-01 | Successful XSS trivially exfiltrates all session tokens from sessionStorage | Next Sprint |
| 9 | **WebSocket connections never re-authenticate** — Stale access up to 2 hours after token expiry or role revocation | AUTH-WS-03, AUTH-WS-05 | Revoked users retain elevated WebSocket privileges (playground, AI generation) for up to 2 hours | Next Sprint |
| 10 | **Post-confirmation DB failure creates orphaned users** — User confirmed in Cognito but never provisioned in database | AUTH-CT-02, AUTH-RBAC-05 | Authentication succeeds but all authorization fails; no self-service recovery; no retry/DLQ | Next Sprint |

### Risk Heat Map

| Domain | Critical | High | Medium | Low | Total | Overall Risk |
|--------|----------|------|--------|-----|-------|--------------|
| Cognito User Pool | 1 | 2 | 1 | 3 | 7 | **High** |
| Lambda Authorizers | 0 | 0 | 5 | 6 | 11 | **Medium** |
| RBAC | 0 | 2 | 5 | 2 | 9 | **High** |
| Token Lifecycle | 0 | 3 | 5 | 1 | 9 | **High** |
| WebSocket Auth | 0 | 3 | 5 | 2 | 10 | **High** |
| Cognito Triggers | 0 | 2 | 4 | 0 | 6 | **High** |
| Identity Pool | 0 | 0 | 3 | 2 | 5 | **Medium** |
| Frontend Session | 0 | 1 | 4 | 3 | 8 | **Medium** |
| **Totals** | **1** | **13** | **32** | **19** | **65** | **HIGH** |

**Interpretation:** The single Critical finding (MFA disabled) combined with 13 High-severity findings across 6 of 8 domains indicates systemic gaps in defense-in-depth controls. The platform's core authorization logic is sound, but the surrounding security envelope needs strengthening — particularly for a system entrusted with solicitor-client privileged legal communications.

---

## 2. Cognito User Pool Assessment

### Current Implementation

The Cognito User Pool is defined in `cdk/lib/api-stack.ts` (lines 193–294) using the AWS CDK `cognito.UserPool` construct.

**User Pool Configuration (`${id}-UserPool`):**

| Setting | Value | CDK Reference |
|---------|-------|---------------|
| Sign-in aliases | `email: true` | `signInAliases` (line 196) |
| Self-signup | `true` | `selfSignUpEnabled` (line 199) |
| Auto-verify | `email: true` | `autoVerify` (line 200) |
| Email verification | 6-digit code (`{####}`) via styled HTML template | `userVerification.emailStyle: CODE` (line 282) |
| Account recovery | `EMAIL_ONLY` | `accountRecovery` (line 292) |
| Removal policy | `RETAIN` | `removalPolicy` (line 293) |
| Email delivery | SES (when `sesVerifiedDomain` provided) or Cognito default | `email: emailConfig` (line 291) |
| MFA | **Not configured** (CDK default = OFF) | No `mfa` property present |
| Advanced Security | **Not configured** (CDK default = OFF) | No `advancedSecurityMode` property present |

**Password Policy:**

| Requirement | Value | CDK Reference |
|-------------|-------|---------------|
| Minimum length | 12 characters | `passwordPolicy.minLength` (line 285) |
| Require lowercase | ✅ | `requireLowercase: true` (line 286) |
| Require uppercase | ✅ | `requireUppercase: true` (line 287) |
| Require digits | ✅ | `requireDigits: true` (line 288) |
| Require symbols | ✅ | `requireSymbols: true` (line 289) |
| Temporary password validity | Not configured (Cognito default: 7 days) | No `tempPasswordValidity` set |

**App Client Configuration (`${id}-pool`):**

| Setting | Value | CDK Reference |
|---------|-------|---------------|
| Auth flow: USER_PASSWORD_AUTH | `true` | `authFlows.userPassword` (line 300) |
| Auth flow: CUSTOM_AUTH | `true` | `authFlows.custom` (line 301) |
| Auth flow: USER_SRP_AUTH | `true` | `authFlows.userSrp` (line 302) |
| Access token validity | 30 minutes | `accessTokenValidity` (line 304) |
| ID token validity | 30 minutes | `idTokenValidity` (line 305) |
| Refresh token validity | **Not configured** (Cognito default: 30 days) | No `refreshTokenValidity` set |
| Token revocation | Not configured (CDK default: enabled) | No explicit `enableTokenRevocation` |
| Prevent user existence errors | Not configured (CDK default: enabled for new clients) | No explicit `preventUserExistenceErrors` |

**Source Files:**
- `cdk/lib/api-stack.ts` — UserPool construct (lines 193–305), Identity Pool (lines 308–320), Cognito triggers (lines 992–999)

### Analysis

#### Password Policy vs NIST SP 800-63B

The configured password policy **partially aligns** with NIST SP 800-63B guidelines but includes composition rules that NIST recommends against:

| NIST SP 800-63B Recommendation | Platform Implementation | Compliance |
|-------------------------------|------------------------|------------|
| Minimum 8 characters (SHALL), prefer ≥15 (SHOULD) | 12 characters minimum | ✅ Exceeds minimum, below preferred |
| Maximum ≥64 characters | Cognito default: 256 characters max | ✅ Compliant |
| No composition rules (no forced uppercase, lowercase, digits, symbols) | All four complexity types required | ⚠️ Deviation — NIST discourages composition rules as they reduce usable password space and encourage predictable patterns (e.g., `Password1!`) |
| Check against breached password lists | Not configured (no Advanced Security Features) | ❌ Non-compliant |
| No periodic password rotation | No rotation policy detected | ✅ Compliant |
| Allow paste into password fields | Frontend-dependent (not CDK concern) | N/A — requires frontend verification |

**Assessment:** The 12-character minimum meets NIST requirements and is appropriate for a legal content platform. However, the mandatory composition rules contradict NIST SP 800-63B Section 5.1.1.2 which states verifiers "SHOULD NOT impose other composition rules." The absence of breached password detection is a significant gap for a platform handling privileged legal content.

#### MFA Configuration

The User Pool has **no MFA configuration** — the `mfa` property is absent from the CDK construct, meaning Cognito defaults to `OFF` (MFA completely disabled, users cannot opt in).

**Risk Assessment by Role:**

| Role | Data Sensitivity | MFA Risk Level | Recommendation |
|------|-----------------|----------------|----------------|
| Admin | Full platform control, user management, AI configuration, all case data | **Critical** — admin compromise = full platform compromise | **Required** (TOTP or SMS) |
| Instructor | Access to multiple students' legal cases, feedback, progress data | **High** — instructor compromise exposes multiple students' privileged legal content | **Required** (TOTP preferred) |
| Student | Own legal cases, interview transcripts, AI-assisted notes | **Medium** — student compromise exposes individual's privileged legal content | **Optional** with strong encouragement |

**Platform Context:** This is a legal education platform handling solicitor-client privileged content in a Canadian legal context. Single-factor authentication for admin and instructor roles is inappropriate given the sensitivity and regulatory implications of unauthorized access to privileged legal communications.

#### Advanced Security Features

Cognito Advanced Security Features (ASF) are **not enabled** — no `advancedSecurityMode` property is present in the CDK construct.

**Absent Capabilities:**

| Feature | Security Benefit | Impact of Absence |
|---------|-----------------|-------------------|
| Adaptive authentication | Risk-based MFA challenges for suspicious sign-ins (new device, unusual location, impossible travel) | No risk-adaptive challenges; all successful password attempts grant access regardless of risk signals |
| Compromised credential detection | Blocks sign-in attempts using credentials found in public breaches | Users with compromised passwords (from other services) can authenticate without intervention |
| Risk-based adaptive responses | Configurable actions (block, MFA challenge, allow) per risk level | No automated response to anomalous authentication patterns |
| Advanced security metrics | CloudWatch metrics for risky sign-in attempts | No visibility into authentication risk signals |

**Recommendation:** Enable ASF in `ENFORCED` mode. The platform handles privileged legal content where unauthorized access has professional and regulatory consequences. ASF adds a significant defense layer at a cost of ~$0.05/MAU/month (Cognito Plus tier feature pricing).

#### Account Lockout Behavior

Cognito implements a **built-in account lockout** mechanism that is **not configurable** via CDK:

- After 5 consecutive failed authentication attempts, Cognito temporarily locks the account
- Lockout duration starts at 1 second and increases exponentially (doubles with each subsequent lockout trigger)
- This is a platform-managed behavior with no CDK configuration surface

**Assessment:**

| Aspect | Status | Risk |
|--------|--------|------|
| Base lockout threshold | 5 failed attempts (Cognito default, non-configurable) | Acceptable baseline |
| Lockout escalation | Exponential backoff | ✅ Good — limits sustained brute-force |
| Credential stuffing protection | Limited without ASF | ⚠️ No detection of distributed credential stuffing (many IPs, one attempt each) |
| Rate limiting (WAF) | 2000 requests/5min per IP + 200/5min per Authorization header | ✅ Provides additional layer |
| Bot detection | Not enabled (no CAPTCHA, no ASF) | ❌ No challenge for automated attacks |

**Gap:** The built-in lockout only protects against naive single-IP brute-force. Distributed credential stuffing attacks (using different IPs with one or two attempts per account) bypass the lockout mechanism entirely. Without Advanced Security Features, the platform relies solely on WAF rate limiting which operates at the IP level and cannot detect distributed attacks targeting specific accounts.

#### Email Verification Flow

**Current Implementation:**
- Verification method: 6-digit numeric code delivered via email (`emailStyle: CODE`)
- Email delivery: SES (production with verified domain) or Cognito default (development)
- Email template: Custom HTML template with the code rendered in a styled `<div class="code">{####}</div>` block
- No sensitive data in email body (only verification code, no user details or tokens)

**Security Assessment:**

| Aspect | Status | Assessment |
|--------|--------|-----------|
| Code delivery mechanism | Email with 6-digit code | ✅ Standard approach |
| Code expiration | Cognito default: 24 hours (not configurable via CDK without custom sender Lambda) | ⚠️ 24 hours is long; 1 hour would be more secure |
| Code length | 6 digits | ✅ Acceptable for email verification (not password reset) |
| Email template security | No sensitive data in body, no PII, no links | ✅ Good — code-only approach prevents phishing link injection |
| Account enumeration via verification | Cognito returns different responses for existing vs non-existing emails during signup | ⚠️ Partially mitigated by `preventUserExistenceErrors` (CDK default for new clients) |
| External font loading | Google Fonts CDN link in email HTML | Low risk — tracking pixel potential, but standard practice |

**Note:** The `preventUserExistenceErrors` setting (enabled by default for new App Clients created via CDK) causes Cognito to return generic errors for operations on non-existent users, mitigating timing-based account enumeration during sign-in. However, during sign-up, a user attempting to register with an already-taken email will receive a different error than a fresh registration, which is inherent to the sign-up flow.

#### Authentication Flows

Three auth flows are enabled on the App Client:

| Auth Flow | CDK Property | Protocol | Password Exposure | Risk Level |
|-----------|-------------|----------|-------------------|------------|
| `USER_SRP_AUTH` | `userSrp: true` | Secure Remote Password | Never leaves client (zero-knowledge proof) | **Low** — cryptographically protected |
| `USER_PASSWORD_AUTH` | `userPassword: true` | Direct username + password | Transmitted in plaintext over TLS | **Medium** — relies entirely on TLS integrity |
| `CUSTOM_AUTH` | `custom: true` | Custom challenge/response | Depends on implementation | **Low** — no custom auth Lambda triggers attached |

**Risk Assessment for USER_PASSWORD_AUTH:**

Enabling `USER_PASSWORD_AUTH` alongside `USER_SRP_AUTH` creates unnecessary exposure:

1. **TLS dependency:** Passwords are transmitted in plaintext within the TLS tunnel. If TLS is compromised at any hop (corporate proxy, compromised CA, downgrade attack), credentials are exposed. SRP prevents this by never transmitting the password.
2. **Server-side password handling:** With USER_PASSWORD_AUTH, Cognito receives and processes the raw password server-side. With SRP, the server only receives a proof — it never handles the raw password.
3. **Amplify SDK default behavior:** The Amplify SDK v6 defaults to SRP when both are available, so USER_PASSWORD_AUTH is a fallback that may not be actively used.
4. **Custom auth flow:** `custom: true` is enabled but no custom auth Lambda triggers (Define Auth Challenge, Create Auth Challenge, Verify Auth Challenge) are attached to the User Pool, making this a no-op configuration that adds no functionality.

**Justification for Removal:** Since SRP is enabled and the Amplify SDK uses SRP by default, `USER_PASSWORD_AUTH` serves no functional purpose. Its presence increases the attack surface for credential interception without providing additional capability.

### Findings

| ID | Finding | Severity | Effort | Status |
|----|---------|----------|--------|--------|
| AUTH-CUP-01 | MFA is completely disabled (set to OFF). Admin and instructor roles have single-factor authentication to access privileged legal content. No per-role MFA enforcement exists. | **Critical** | Medium | New |
| AUTH-CUP-02 | Advanced Security Features (adaptive authentication, compromised credential detection) are not enabled. No risk-based authentication challenges or breached password blocking. | **High** | Low | New |
| AUTH-CUP-03 | USER_PASSWORD_AUTH enabled alongside SRP, allowing plaintext password transmission over TLS without cryptographic protection. No functional justification exists since SRP is available. | **Medium** | Low | New |
| AUTH-CUP-04 | Password policy uses mandatory composition rules (uppercase, lowercase, digits, symbols) contrary to NIST SP 800-63B Section 5.1.1.2 recommendations. Composition rules encourage predictable patterns. | **Low** | Low | New |
| AUTH-CUP-05 | No breached password detection configured. Users can authenticate with passwords found in public breach databases (requires Advanced Security Features). | **High** | Low | New |
| AUTH-CUP-06 | CUSTOM_AUTH flow enabled on App Client but no custom auth Lambda triggers (Define/Create/Verify Auth Challenge) are attached. Unnecessary auth flow enabled without functionality. | **Low** | Low | New |
| AUTH-CUP-07 | Verification code validity period is 24 hours (Cognito default). Extended validity window increases risk of code interception and replay. | **Low** | Medium | New |

### Recommendations

**Immediate (AUTH-CUP-01 — Critical):**

Enable MFA with role-appropriate enforcement:

```typescript
// In UserPool construct
this.userPool = new cognito.UserPool(this, `${id}-pool`, {
  // ... existing config ...
  mfa: cognito.Mfa.OPTIONAL, // Allow all users to enable MFA
  mfaSecondFactor: {
    sms: true,   // SMS MFA (fallback)
    otp: true,   // TOTP MFA (preferred — authenticator apps)
  },
});
```

Then enforce MFA for admin/instructor roles via a Pre-Authentication Lambda trigger that checks the user's database role and requires MFA challenge if the user has admin or instructor role but hasn't configured MFA. Alternatively, use Cognito Advanced Security adaptive authentication to require MFA based on risk signals.

**Immediate (AUTH-CUP-02, AUTH-CUP-05 — High):**

Enable Advanced Security Features:

```typescript
this.userPool = new cognito.UserPool(this, `${id}-pool`, {
  // ... existing config ...
  advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,
});
```

This enables:
- Compromised credential detection (blocks sign-ins using breached passwords)
- Adaptive authentication (risk-based MFA challenges)
- Security metrics in CloudWatch

**Quick Win (AUTH-CUP-03 — Medium):**

Remove unnecessary USER_PASSWORD_AUTH flow:

```typescript
this.appClient = this.userPool.addClient(`${id}-pool`, {
  userPoolClientName: userPoolName,
  authFlows: {
    userPassword: false,  // Remove plaintext password flow
    custom: false,        // Remove unused custom auth flow (AUTH-CUP-06)
    userSrp: true,        // Keep SRP as sole auth flow
  },
  accessTokenValidity: cdk.Duration.minutes(30),
  idTokenValidity: cdk.Duration.minutes(30),
});
```

**Note:** Verify that no backend services (admin scripts, test tooling, CI/CD) use `USER_PASSWORD_AUTH` directly via the AWS SDK before removing.

**Backlog (AUTH-CUP-04 — Low):**

NIST SP 800-63B recommends removing composition rules in favor of longer minimum lengths and breached password checks. Once Advanced Security Features are enabled (providing breached password detection), consider:

```typescript
passwordPolicy: {
  minLength: 15,           // Increase minimum length (compensates for removing composition)
  requireLowercase: false, // Remove composition rules per NIST
  requireUppercase: false,
  requireDigits: false,
  requireSymbols: false,
},
```

This is a lower priority change that should be accompanied by updated user-facing password guidance and frontend validation updates.

---

## 3. Lambda Authorizer Assessment

### Current Implementation

All three REST API authorizers (`adminAuthorizerFunction.js`, `instructorAuthorizerFunction.js`, `studentAuthorizerFunction.js`) follow a near-identical pattern:

1. **JWT Verification:** Each uses `aws-jwt-verify` (`CognitoJwtVerifier`) configured with:
   - **Token type:** `tokenUse: "id"` — validates Cognito **ID tokens** (not access tokens)
   - **Claims verified:** `userPoolId` (issuer), `clientId` (audience), token signature (via JWKS), expiration (`exp`)
   - **Claims NOT verified:** Cognito groups, custom attributes, `email_verified`, `token_use` cross-check beyond the library's built-in check

2. **IDP Configuration:** Retrieved from AWS Secrets Manager (`SM_IDP_CREDENTIALS`) during cold start. The secret contains `JWT_ISSUER_ID` (userPoolId) and `JWT_CLIENT_ID` (clientId).

3. **User Resolution:** After JWT verification, the `sub` claim is extracted as `idpId` and used to query the PostgreSQL database (`users` table) via RDS Proxy to retrieve `user_id`, `user_email`, `first_name`, `last_name`, and `roles`.

4. **Role Enforcement:** Each authorizer checks that the user's `roles` array (from the database) includes the required role (`admin`, `instructor`, or `student`). The student authorizer has additional logic for shared routes and instructor-accessible case routes.

5. **IAM Policy Response:** On success, returns an Allow policy scoped to `{stage}/{method}/{role}/*` (e.g., `*/*/admin/*`) with user metadata in the authorization context. On failure, throws `"Unauthorized"`.

6. **Module-scope caching:** A `userMetadataCache` object at module level persists across warm invocations. A `forceRefresh` parameter allows bypassing the cache on role-miss to handle stale data.

**Source Files:**
- `cdk/lambda/authorization/adminAuthorizerFunction.js`
- `cdk/lambda/authorization/instructorAuthorizerFunction.js`
- `cdk/lambda/authorization/studentAuthorizerFunction.js`
- `cdk/lambda/authorization/initializeConnection.js` — Database connection initialization
- `cdk/lambda/authorization/wsAuthorizer.js`
- `cdk/OpenAPI_Swagger_Definition.yaml` — Authorizer cache TTL configuration

### Analysis

#### JWT Verification Configuration

**ID Token vs Access Token Design Choice:**

All authorizers validate Cognito **ID tokens** (`tokenUse: "id"`) rather than access tokens. This is a deliberate architectural decision with the following security implications:

- **ID tokens contain user identity claims** (`email`, `name`, `sub`) needed for user resolution, eliminating an extra Cognito API call.
- **Access tokens are the OAuth 2.0 standard** for API authorization; ID tokens are intended for client-side identity confirmation.
- **Token confusion risk is LOW** because `aws-jwt-verify` enforces `tokenUse: "id"` — an access token presented to these authorizers will be rejected since its `token_use` claim is `"access"`, not `"id"`. The library verifies this claim.
- **However**, if a different service in the ecosystem validates access tokens, an attacker who obtains an ID token cannot use it against that service (and vice versa). The consistent choice across all authorizers eliminates cross-service token confusion within this platform.

**Claims Not Verified:**
- `cognito:groups` — Not validated in JWT; roles are enforced via database query instead. This means Cognito group membership is entirely unused for authorization, which is acceptable but means groups cannot serve as a secondary enforcement layer.
- `email_verified` — Not explicitly checked. A user with an unverified email could potentially authenticate if they bypassed the verification flow (though Cognito's auto-verify-email setting mitigates this).
- Custom attributes — Not validated; no custom attributes appear to be configured.

**Assessment:** The ID token choice is acceptable for this architecture because the authorizer immediately resolves the user to a database record (where authoritative role data lives) rather than relying on token claims for authorization decisions. The `aws-jwt-verify` library provides robust signature, expiration, issuer, and audience validation.

#### Role Enforcement Logic

**Database Query Pattern:**

Each authorizer queries the `users` table by `idp_id` (the Cognito `sub` claim):
```sql
SELECT user_id, user_email, first_name, last_name, roles FROM users WHERE idp_id = ${idpId};
```

This is parameterized via the `postgres` tagged template literal, preventing SQL injection.

**Role Check — Admin and Instructor Authorizers:**

1. First checks `user.roles.includes("admin"|"instructor")` using cached data.
2. If the role is NOT found, calls `getUserMetadataFromDatabase(idpId, true)` to force a fresh database query.
3. If the role is still not found after refresh, throws `"Unauthorized"`.

This two-stage check mitigates stale cache entries from a previous warm invocation where the user didn't hold the role yet (e.g., admin just granted the role).

**Role Check — Student Authorizer (More Complex):**

The student authorizer has additional route-awareness:
- **Shared routes** (`GET /student/profile`, `GET /student/role_labels`, `GET /student/get_disclaimer`, `POST /student/accept_disclaimer`) are accessible to any authenticated user regardless of role.
- **Instructor case routes** (`GET /student/case_page`, `GET /student/get_transcriptions`, etc.) are accessible to users with the `instructor` role (enabling instructors to view student case data).
- For all other `/student/*` endpoints, the `student` role is enforced with the same two-stage forceRefresh pattern.

**Strengths:**
- Database as authoritative role source (not JWT claims) means role revocation takes effect immediately on next non-cached invocation.
- ForceRefresh pattern handles the race between role grant and warm Lambda cache.
- Parameterized queries prevent SQL injection.

**Weaknesses:**
- The forceRefresh pattern protects against granting-then-accessing but does NOT fully protect against revocation: if a user had the role cached, they pass on first check without hitting the database. The cache persists until the Lambda execution context is recycled. Combined with the API Gateway authorizer response cache (60s TTL), there is a window where a revoked user retains access.
- No explicit `user.roles` type validation — if `roles` is somehow `null` or not an array, the `includes()` call on the admin/instructor authorizers would throw. The student authorizer handles this with `Array.isArray(user.roles) ? user.roles : []`.

#### Authorizer Cache Behavior

**Configuration (from `cdk/OpenAPI_Swagger_Definition.yaml`):**

All three REST API authorizers are configured with the same cache TTL:

| Authorizer | TTL (seconds) | OpenAPI Property | Cache Key |
|---|---|---|---|
| `adminAuthorizer` | 60 | `authorizerResultTtlInSeconds: 60` | Authorization header value (token) |
| `instructorAuthorizer` | 60 | `authorizerResultTtlInSeconds: 60` | Authorization header value (token) |
| `studentAuthorizer` | 60 | `authorizerResultTtlInSeconds: 60` | Authorization header value (token) |

All three authorizers use `type: token` with `name: Authorization` and `in: header`, meaning API Gateway uses the full Authorization header value as the cache key.

**How API Gateway Token Authorizer Caching Works:**

1. Client sends request with `Authorization: <ID_TOKEN>`.
2. API Gateway checks its cache for the exact token string.
3. If cached (within 60s of last invocation for that token): return the cached IAM policy without invoking the Lambda authorizer.
4. If not cached: invoke the Lambda authorizer, cache the response for 60 seconds, and use the returned policy.

**Assessment — Role Revocation Window:**

When an admin revokes a user's role in the database, the user may retain access for up to **60 seconds** due to the cached Allow policy:

| Timeline | User Access State | Explanation |
|---|---|---|
| T+0s | Access granted | Admin revokes user's role in database |
| T+0s to T+60s | **Access still granted** | API Gateway returns cached Allow policy without invoking the Lambda authorizer |
| T+60s | Cache expires | Next request triggers Lambda authorizer invocation |
| T+60s+ | Access denied | Lambda queries database, finds role revoked, returns Deny |

**Combined with the Lambda-level `userMetadataCache`:** Even after the API Gateway cache expires, if the same Lambda execution context handles the request, the module-scope `userMetadataCache` might still hold the old user record (with the revoked role). However, the `forceRefresh` pattern mitigates this specific scenario: if the user's cached role no longer matches the required role, the authorizer re-queries the database. Since role revocation removes the role from the array, the initial cache check will fail (role missing), triggering a database re-query that correctly denies access.

**Effective revocation delay:** Maximum **60 seconds** (the API Gateway cache TTL), which is the dominant factor. The Lambda-level cache is only relevant when a user already held the role in cache from a prior request to the same Lambda instance.

**Risk Assessment:**

| Risk Factor | Assessment |
|---|---|
| Is 60s acceptable for role revocation? | **Generally acceptable** for a legal education platform. Role revocation is an admin action, not a security incident response mechanism. A 60-second window is unlikely to enable meaningful exploitation unless an active attacker is exploiting a compromised account in real-time. However, for critical security incidents (compromised admin account), 60 seconds of continued access is non-trivial. |
| Reduction available? | The TTL can be reduced to 0 (no caching) or increased up to 3600s. Setting to 0 eliminates the window but invokes the Lambda authorizer on every request, increasing latency and cost. A value of 30s would halve the window at modest cost. |
| Comparison to token-based systems | In a pure JWT system (without Lambda authorizers), role revocation would not take effect until the token expires (30 minutes for this platform). The 60-second window is **significantly better** than token-expiry-based revocation. |

**Assessment — Cache Key Isolation:**

The cache key is the **full Authorization header value** — the complete Cognito ID token string. Because each user receives a unique JWT (containing their unique `sub` claim, issued-at time, and signature), two different users will **never** share a cache key. This provides strong user isolation.

| Isolation Scenario | Cache Behavior | Risk |
|---|---|---|
| Different users, different tokens | Separate cache entries — no cross-user leakage | **None** |
| Same user, same token (within 30min validity) | Same cache entry — consistent policy response | **None** — expected behavior |
| Same user, refreshed token (new JWT) | New cache entry — previous entry may still be live for ≤60s | **None** — both entries return Allow for the same user |

**Assessment — Token Refresh Impact:**

When the Amplify SDK refreshes the ID token (typically before the 30-minute expiry):

1. The frontend obtains a new ID token with a new `iat` (issued-at) claim and new signature.
2. The new token is a different string from the old token — it creates a **new cache entry** in API Gateway.
3. The first request with the new token triggers a Lambda authorizer invocation (cache miss), adding ~50–300ms latency for that single request.
4. Subsequent requests within 60s use the new cached entry.

**Performance concern:** Token refresh happens approximately every 25–29 minutes (Amplify SDK pre-emptive refresh). This means each user experiences one authorizer Lambda invocation per ~25–30 minutes (one cache miss per token refresh cycle). Given the 60-second cache TTL, this is a negligible performance impact — the cache miss on refresh is indistinguishable from the natural cache misses that occur every 60 seconds anyway.

**Conclusion:** The token refresh pattern does **not** degrade performance beyond the baseline cache-miss frequency. The 60-second TTL is the dominant factor in how often the authorizer Lambda is invoked (once per 60s per active user), regardless of token refresh timing.

#### IAM Policy Resource Scope

**Policy Construction Pattern:**

Each authorizer constructs the Allow policy resource by extracting the API Gateway stage prefix from the `methodArn` and appending a role-scoped wildcard:

```javascript
// Admin authorizer (adminAuthorizerFunction.js)
const parts = event.methodArn.split("/");
const resource = parts.slice(0, 2).join("/") + "/*/admin/*";

// Instructor authorizer (instructorAuthorizerFunction.js)
const resource = parts.slice(0, 2).join("/") + "/*/instructor/*";

// Student authorizer (studentAuthorizerFunction.js)
const resource = parts.slice(0, 2).join("/") + "/*/student/*";
```

**Resulting IAM Policy Resources:**

| Authorizer | Resource Pattern | Example Resolved ARN |
|---|---|---|
| Admin | `arn:aws:execute-api:{region}:{account}:{api-id}/{stage}/*/admin/*` | `arn:aws:execute-api:ca-central-1:123456789:abc123/prod/*/admin/*` |
| Instructor | `arn:aws:execute-api:{region}:{account}:{api-id}/{stage}/*/instructor/*` | `arn:aws:execute-api:ca-central-1:123456789:abc123/prod/*/instructor/*` |
| Student | `arn:aws:execute-api:{region}:{account}:{api-id}/{stage}/*/student/*` | `arn:aws:execute-api:ca-central-1:123456789:abc123/prod/*/student/*` |

The `*/*/{role}/*` pattern means: any HTTP method (`*`), the role path prefix (`admin/`, `instructor/`, `student/`), and any sub-path (`*`).

**Cross-Role Replay Analysis:**

A critical question is: can a cached policy from one authorizer be used to access a different role's endpoints?

**Answer: NO — by design, cross-role replay is not possible.**

The defense works at multiple layers:

| Defense Layer | Mechanism | Why Cross-Role Replay Fails |
|---|---|---|
| **Route-authorizer binding** | Each `/admin/*` route is bound to `adminAuthorizer`, each `/instructor/*` to `instructorAuthorizer`, each `/student/*` to `studentAuthorizer` in the OpenAPI spec | A request to `/admin/users` will ONLY invoke `adminAuthorizer` — never the instructor or student authorizer |
| **IAM policy scope** | Admin authorizer returns `*/admin/*`, instructor returns `*/instructor/*`, student returns `*/student/*` | Even if a cached admin policy were somehow evaluated against an instructor route, it would not match `*/instructor/*` |
| **Cache key per-authorizer** | API Gateway maintains separate caches per authorizer instance | A cached response from `adminAuthorizer` is never returned for requests that trigger `instructorAuthorizer` |

**Scenario Analysis — Compromised Authorizer Response:**

If an attacker could intercept and replay a cached authorizer response:

| Attack Scenario | Outcome | Risk |
|---|---|---|
| Replay admin policy against `/instructor/*` route | **Blocked** — the instructor route invokes `instructorAuthorizer` (separate cache), and the admin policy resource `*/admin/*` doesn't match `/instructor/*` | None |
| Replay admin policy against another admin route | **Allowed within 60s cache window** — but this is expected behavior (the policy covers `*/admin/*` which includes all admin endpoints) | Acceptable — same-role breadth is intentional for cache efficiency |
| Compromised admin authorizer Lambda returns `*/instructor/*` scope | **Would grant cross-role access** — but this requires Lambda code compromise, not a cache exploit | Mitigated by code integrity controls, not by policy design |

**Wildcard Breadth Assessment:**

The `*/admin/*` wildcard allows any cached admin policy to authorize any admin endpoint. This is a deliberate trade-off:

- **Without wildcard:** Each request would require a separate authorizer invocation (cache key = token + method + path), defeating the purpose of caching.
- **With wildcard:** One authorizer invocation per 60 seconds covers all endpoints within the role, reducing Lambda invocations by ~95% for active users.
- **Security implication:** A user validated as admin can access ALL admin endpoints without granular per-endpoint authorization at the API Gateway level. This is acceptable because:
  1. The admin role is the highest privilege level — all admin endpoints require the same role.
  2. Per-endpoint granularity (if needed) is enforced at the handler level, not the authorizer level.
  3. The instructor and student wildcards similarly allow full access within their respective role paths.

**Student Authorizer — Broader Scope Consideration:**

The student authorizer's `*/student/*` policy is notable because it grants access to all `/student/*` endpoints in the cached response, even though the student authorizer performs route-specific logic (shared routes, instructor case routes) during the authorization check. Once the Allow policy is cached, subsequent requests within 60 seconds bypass the route-specific logic entirely.

This means:
- If an instructor accesses a student's case data via an `instructorCaseRoutes` endpoint, the cached Allow policy would also cover `/student/new_case` or `/student/edit_case` — endpoints that should require the `student` role, not just `instructor`.
- **In practice**, this is a limited risk because: (a) the student authorizer already validates that the user holds either the student role or instructor role for allowed routes, and (b) the handler layer performs additional ownership validation that prevents instructors from creating or modifying student cases.
- **However**, if a new `/student/*` endpoint is added that the student authorizer should restrict to students-only, the cached `*/student/*` policy from a prior instructor-accessible route invocation could incorrectly allow access for the full 60-second window.

**OpenAPI Route Structure Confirmation:**

All routes in the OpenAPI spec follow strict role-prefixed paths:

| Path Prefix | Authorizer | Total Endpoints |
|---|---|---|
| `/admin/*` | `adminAuthorizer` | ~20 endpoints (user management, prompts, AI config, settings) |
| `/instructor/*` | `instructorAuthorizer` | ~10 endpoints (students, cases, feedback) |
| `/student/*` | `studentAuthorizer` | ~25 endpoints (cases, chat, audio, notifications, profile) |

No endpoint crosses role path boundaries (e.g., no `/admin/*` route uses `studentAuthorizer`), and no endpoint exists outside these three prefixes (other than the WebSocket API which uses a separate authorizer).

#### Error Handling

All three authorizers follow a consistent error handling pattern:

**Consistent "Unauthorized" Response:**
- Every error path (JWT verification failure, user not found, role mismatch, database error) ultimately throws `new Error("Unauthorized")`.
- This is the exact string required by API Gateway to return a 401 HTTP response to the caller.
- The outer `catch` block in the handler wraps all failures with `throw new Error("Unauthorized")`, ensuring no alternative error messages escape.

**No Information Leakage to Client:**
- Error details are logged server-side via `@aws-lambda-powertools/logger` (error type, error message for debugging) but never returned to the caller.
- The client receives only a generic 401 response regardless of whether the failure was due to: expired token, invalid signature, user not found in database, role mismatch, or database connectivity failure.

**Error Path Coverage:**

| Failure Scenario | Handling | Client Response |
|---|---|---|
| Missing/malformed Authorization header | `jwtVerifier.verify()` throws → caught → `"Unauthorized"` | 401 |
| Expired token | `jwtVerifier.verify()` throws → caught → `"Unauthorized"` | 401 |
| Invalid signature | `jwtVerifier.verify()` throws → caught → `"Unauthorized"` | 401 |
| Wrong token type (access token presented) | `jwtVerifier.verify()` rejects `tokenUse != "id"` → `"Unauthorized"` | 401 |
| Wrong audience (different client ID) | `jwtVerifier.verify()` rejects → `"Unauthorized"` | 401 |
| User not found in database | `getUserMetadataFromDatabase` throws → caught → `"Unauthorized"` | 401 |
| Role not present after forceRefresh | Explicit throw `"Unauthorized"` | 401 |
| Database connection failure | `initializeConnection` or query throws → caught → `"Unauthorized"` | 401 |
| Secrets Manager retrieval failure | `initializeJwtVerifier` throws → caught → `"Unauthorized"` | 401 |

**Assessment:** Error handling is well-implemented. The consistent `"Unauthorized"` throw pattern is correct for API Gateway Lambda authorizers. No internal details leak to clients. Server-side logging provides sufficient debugging information without exposing it externally.

**Minor concern:** The `logger.error("User lookup failed", { errorType, errorMessage })` and `logger.warn("Access denied: user does not have admin role", { userId })` log the internal `userId` and error details server-side. While `idpId` is not directly logged in error paths, the `methodArn` (logged on invocation) could be correlated with CloudWatch request IDs to identify specific users. CloudWatch log access controls should ensure only authorized operators can view authorizer logs.

#### Database Connection Pattern

**Architecture:**
- `initializeConnection.js` creates a PostgreSQL connection via RDS Proxy using the `postgres` library.
- The connection is stored on `global.sqlConnection`, persisting across warm Lambda invocations within the same execution context.
- Configuration: `max: 1` (single connection per Lambda instance), `idle_timeout: 20` (seconds), `connect_timeout: 10` (seconds), `ssl: "require"`.

**Credential Retrieval:**
- Database credentials are retrieved from Secrets Manager (`SM_DB_CREDENTIALS`) during cold start.
- IDP credentials (for JWT verifier) are retrieved from a separate secret (`SM_IDP_CREDENTIALS`) during cold start.
- Both retrievals happen sequentially on first invocation, contributing to cold-start latency.

**Cold-Start Latency Assessment:**

A cold start requires:
1. Secrets Manager call for IDP credentials (~50-200ms)
2. JWT verifier initialization (JWKS fetch from Cognito, ~100-300ms)
3. Secrets Manager call for DB credentials (~50-200ms)
4. PostgreSQL connection establishment via RDS Proxy (~100-500ms)

Total cold-start overhead: **~300-1200ms** in addition to normal execution time. This is significant for authorization latency but is mitigated by:
- API Gateway's authorizer response caching (60s TTL) reducing invocation frequency.
- Lambda execution context reuse keeping the connection and verifier warm.

**Connection Pool Exhaustion Risk:**

- `max: 1` ensures each Lambda instance holds at most one connection.
- RDS Proxy manages connection pooling at the proxy layer, multiplexing Lambda connections to a smaller set of database connections.
- Under high concurrency (many simultaneous Lambda instances), each instance creates one connection to RDS Proxy. The proxy's connection limit to the actual RDS instance could be exceeded, but this is managed by RDS Proxy's queuing behavior.
- **Risk: LOW** — RDS Proxy is specifically designed for this Lambda pattern.

**Connection Leak Risk:**

- If the Lambda execution context is frozen mid-query, the `postgres` library's connection remains open but idle.
- The `idle_timeout: 20` setting means the connection will be closed after 20 seconds of inactivity, preventing indefinite resource holding.
- RDS Proxy also implements its own idle connection timeout.
- **Risk: LOW** — Both client-side and proxy-side timeouts prevent leaks.

**Concern:** Database credentials are cached for the lifetime of the Lambda execution context (potentially hours). If credentials are rotated in Secrets Manager, the running Lambda instance will continue using the old credentials until the execution context is recycled. This is standard Lambda behavior but means credential rotation requires Lambda function redeployment or execution context invalidation.

#### User Metadata Cache

**Implementation:**

```javascript
let userMetadataCache = {};
```

This module-scope object persists across warm Lambda invocations within the same execution context.

**Cache Behavior:**
- **Write:** On successful database query, `userMetadataCache[idpId] = user` stores the full user record.
- **Read:** On subsequent invocations, `userMetadataCache[idpId]` returns the cached record without a database query.
- **Invalidation:** Only via `forceRefresh = true` parameter, which re-queries the database and overwrites the cache entry.
- **Eviction:** None — entries are never removed. The cache only clears when the Lambda execution context is destroyed.

**Stale Entry Risk:**

| Scenario | Impact | Mitigation |
|---|---|---|
| User deleted from database | Cached entry continues to grant access until execution context recycle | **No mitigation** — deleted user retains access for potentially hours |
| User deactivated (if implemented) | Same as deletion — cache still shows valid user | **No mitigation** |
| Role revoked | forceRefresh on role-miss will detect revocation for the specific role checked | Partial — only triggers if cached role doesn't match the required role |
| User email/name changed | Stale metadata passed to handlers in context | Low impact — cosmetic only |

**Unbounded Growth:**

- Each unique `idpId` that authenticates through a given Lambda instance adds an entry to the cache.
- There is no maximum size limit, no LRU eviction, and no TTL per entry.
- In practice, growth is bounded by: (a) the number of unique users who hit a specific Lambda instance during its lifetime, and (b) Lambda execution context recycling (typically after minutes to hours of inactivity).
- **Risk: LOW for memory** — user records are small (~200 bytes each), and even 10,000 unique users would consume only ~2MB.
- **Risk: MEDIUM for staleness** — entries persist for the lifetime of the execution context with no TTL.

**Invalidation Mechanism:**

- No explicit invalidation mechanism exists.
- The `forceRefresh` pattern is a partial solution: it refreshes on role-miss, but does NOT detect user deletion (since a deleted user won't fail the initial cache check — the cached record still looks valid).
- No event-driven cache invalidation (e.g., EventBridge event on user deletion) exists.
- The API Gateway authorizer cache (60s TTL) provides a separate caching layer that limits how long a stale Allow policy persists, but the Lambda-level `userMetadataCache` can be stale for much longer.

### Findings

| ID | Finding | Severity | Effort | Status |
|----|---------|----------|--------|--------|
| AUTH-LA-01 | **User metadata cache has no TTL or eviction — deleted/deactivated users retain access.** The module-scope `userMetadataCache` persists for the Lambda execution context lifetime (potentially hours) with no TTL, LRU eviction, or event-driven invalidation. A user deleted from the database continues to pass authorization if their entry is cached. | Medium | Medium | New |
| AUTH-LA-02 | **No `email_verified` claim validation in JWT verification.** The authorizers do not check that the ID token's `email_verified` claim is `true`. If a user bypasses email verification (e.g., admin-created user), they could authenticate without confirmed email ownership. | Low | Low | New |
| AUTH-LA-03 | **Inconsistent `roles` array type handling across authorizers.** The admin and instructor authorizers call `user.roles.includes()` without checking if `roles` is an array — a null or non-array value would throw a runtime error. The student authorizer defensively uses `Array.isArray(user.roles) ? user.roles : []`. All three should use the defensive pattern. | Low | Low | New |
| AUTH-LA-04 | **Cold-start latency from dual Secrets Manager calls + JWKS fetch + DB connection.** First invocation requires sequential credential retrieval (IDP secret + DB secret), JWKS download, and database connection establishment, totaling 300–1200ms. During this window, the requesting API call is blocked. | Low | Medium | New |
| AUTH-LA-05 | **Database credentials cached for execution context lifetime — no rotation handling.** Secrets Manager credentials retrieved at cold start are used indefinitely until context recycle. If DB credentials are rotated, active Lambda instances use stale credentials until recycled or redeployed. | Low | Medium | New |
| AUTH-LA-06 | **ForceRefresh pattern does not detect user deletion.** The `forceRefresh` mechanism only triggers when the required role is missing from the cached record. If a user is deleted from the database entirely, the cache still holds their old record with a valid role, and the authorizer never re-queries. | Medium | Medium | New |
| AUTH-LA-07 | **Student authorizer hardcodes route lists creating maintenance coupling.** The `sharedRoutes` and `instructorCaseRoutes` sets in `studentAuthorizerFunction.js` must be manually synchronized with the OpenAPI spec. If a new shared or instructor-accessible student endpoint is added without updating these sets, the authorizer will incorrectly deny access or (worse) if the sets are accidentally expanded, allow unauthorized access. | Low | Medium | New |
| AUTH-LA-08 | **Near-complete code duplication across three authorizer files (~90% shared code).** The admin, instructor, and student authorizers contain nearly identical implementations (JWT verification, DB connection, cache, error handling) copied rather than shared via a common module. This increases risk of inconsistent security fixes — as evidenced by AUTH-LA-03 where only the student authorizer has defensive `Array.isArray()` checks. | Low | Medium | New |
| AUTH-LA-09 | **60-second authorizer cache creates role revocation delay.** The `authorizerResultTtlInSeconds: 60` setting on all three authorizers means a user whose role is revoked by an admin can continue accessing protected endpoints for up to 60 seconds via the cached Allow policy. During an active security incident (compromised admin account), this window allows continued unauthorized actions. | Medium | Low | New |
| AUTH-LA-10 | **Student authorizer cached `*/student/*` policy bypasses route-specific logic.** The student authorizer performs route-aware checks (shared routes, instructor case routes) during the initial invocation, but the cached Allow policy grants `*/student/*` access for all subsequent requests within 60 seconds. An instructor whose request triggers the student authorizer via an `instructorCaseRoutes` endpoint receives a cached policy that also covers student-only endpoints (e.g., `/student/new_case`) — handler-level enforcement is the only remaining control during the cache window. | Medium | Medium | New |
| AUTH-LA-11 | **No mechanism to invalidate API Gateway authorizer cache on demand.** There is no API or administrative action to flush the authorizer cache for a specific user (token). During a security incident requiring immediate access revocation, the only options are: (a) wait 60 seconds for cache expiry, (b) invalidate the user's token via Cognito GlobalSignOut (which won't clear the API Gateway cache), or (c) redeploy the API stage (which flushes all caches and impacts all users). A per-user emergency revocation mechanism is absent. | Medium | High | New |

### Recommendations

1. **AUTH-LA-01 / AUTH-LA-06 — Add TTL-based cache expiration:**
   Implement a TTL (e.g., 60–120 seconds) on `userMetadataCache` entries. Store a timestamp with each entry and invalidate entries older than the TTL, forcing a database re-query. This ensures deleted or deactivated users lose access within a bounded time window.

   ```javascript
   const CACHE_TTL_MS = 60_000; // 60 seconds

   async function getUserMetadataFromDatabase(idpId, forceRefresh = false) {
     const cached = userMetadataCache[idpId];
     if (!forceRefresh && cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
       return cached.user;
     }
     // ... database query ...
     userMetadataCache[idpId] = { user, timestamp: Date.now() };
     return user;
   }
   ```

2. **AUTH-LA-02 — Validate `email_verified` claim (optional hardening):**
   If business requirements mandate confirmed email ownership for API access, add `email_verified: true` validation after JWT verification:
   ```javascript
   if (payload.email_verified !== true) {
     throw new Error("Unauthorized");
   }
   ```

3. **AUTH-LA-03 — Standardize defensive `roles` handling:**
   Apply the student authorizer's pattern to admin and instructor authorizers:
   ```javascript
   const roles = Array.isArray(user.roles) ? user.roles : [];
   if (!roles.includes("admin")) { ... }
   ```

4. **AUTH-LA-04 — Reduce cold-start latency:**
   - Use Provisioned Concurrency for authorizer Lambdas if authorization latency SLAs are tight.
   - Consider parallelizing the IDP and DB Secrets Manager calls during initialization.

5. **AUTH-LA-05 — Handle credential rotation gracefully:**
   Implement a retry-on-auth-failure pattern: if a database query fails with an authentication error, re-fetch credentials from Secrets Manager and reinitialize the connection before throwing `"Unauthorized"`.

6. **AUTH-LA-07 — Externalize route-role configuration:**
   Move the `sharedRoutes` and `instructorCaseRoutes` definitions to a shared configuration module (or derive them from the OpenAPI spec at build time) to prevent drift between the authorizer logic and API route definitions. Alternatively, handle shared-route logic at the handler layer rather than the authorizer layer.

7. **AUTH-LA-08 — Extract shared authorizer logic into a common module:**
   Refactor the three authorizers to share a common module (e.g., `authorizerBase.js`) containing JWT verification initialization, database user resolution, cache management, and error handling. Each role-specific authorizer would only specify: the required role name and any role-specific logic (like the student authorizer's shared routes). This eliminates the inconsistency risk and reduces maintenance burden.

   ```javascript
   // authorizerBase.js (proposed)
   async function authorize(event, { requiredRole, allowWithoutRole }) {
     // Shared: JWT verify, user lookup, cache, error handling
     // Role-specific: requiredRole check, allowWithoutRole callback
   }
   ```

8. **AUTH-LA-09 — Reduce authorizer cache TTL for security-critical scenarios:**
   Consider reducing the `authorizerResultTtlInSeconds` from 60 to 30 seconds to halve the role revocation window. The trade-off is a 2x increase in authorizer Lambda invocations (and associated latency/cost), which is modest for a legal platform's typical user concurrency:

   ```yaml
   # In OpenAPI_Swagger_Definition.yaml (all three authorizers)
   x-amazon-apigateway-authorizer:
     type: token
     authorizerResultTtlInSeconds: 30  # Reduced from 60
   ```

   For environments where immediate revocation is critical, setting to `0` (no cache) eliminates the window entirely at the cost of invoking the authorizer Lambda on every request.

9. **AUTH-LA-10 — Narrow student authorizer cached policy scope (defense-in-depth):**
   The current `*/student/*` policy grants broad access after a single authorization check. For stronger defense-in-depth, consider one of:
   - **Option A (recommended):** Accept the current design but ensure all new `/student/*` endpoints have handler-level role enforcement as a mandatory second check, not just relying on the authorizer.
   - **Option B (higher effort):** Change the student authorizer to return a method+path-specific resource (e.g., `*/GET/student/case_page`) instead of `*/student/*`. This disables API Gateway caching efficiency (each endpoint becomes a unique cache entry) but provides precise IAM-level enforcement.
   - **Option C:** Split shared routes and instructor-accessible routes to a separate path prefix (e.g., `/shared/profile`, `/case-view/case_page`) with their own authorizer that doesn't require the student role.

10. **AUTH-LA-11 — Implement emergency access revocation mechanism:**
    For security incident response, implement one of:
    - **Short-term:** Create an admin endpoint that calls Cognito `AdminUserGlobalSignOut` (invalidates refresh tokens, forcing re-authentication) combined with a documented runbook noting the 60-second cache window.
    - **Medium-term:** Implement a "revoked tokens" check at the handler layer using a fast data store (DynamoDB or ElastiCache) that handlers consult before processing requests, bypassing the cached authorizer policy.
    - **Long-term:** Move to a request-level token validation pattern (TTL = 0) for admin endpoints with Provisioned Concurrency to absorb the latency cost.

---

## 4. Role-Based Access Control (RBAC) Assessment

### Current Implementation

**Source Files:**
- `cdk/lambda/handlers/utils/authorization.js` — Handler-level object authorization checks (BOLA prevention)
- `cdk/lambda/authorization/addStudentOnSignUp.js` — Role assignment logic (Post-Confirmation trigger)
- `cdk/OpenAPI_Swagger_Definition.yaml` — Route-level security scheme bindings (3 authorizers)
- `cdk/lambda/authorization/adminAuthorizerFunction.js` — Admin role validation
- `cdk/lambda/authorization/instructorAuthorizerFunction.js` — Instructor role validation
- `cdk/lambda/authorization/studentAuthorizerFunction.js` — Student role validation
- `cdk/lambda/handlers/adminFunction.js` — Admin role elevation endpoints
- `cdk/lambda/handlers/instructorFunction.js` — Instructor data access with BOLA checks
- `cdk/lambda/handlers/studentFunction.js` — Student data scoping with BOLA checks

#### Three-Role Model

The platform uses three roles: **admin**, **instructor**, and **student**.

| Aspect | Implementation |
|--------|---------------|
| **Storage** | PostgreSQL `users` table, `roles` column typed `user_role[]` (array). A user may hold multiple roles simultaneously. |
| **Assignment — First user** | `addStudentOnSignUp.js` checks `SELECT COUNT(*) FROM users`. If count is 0, the user is assigned `admin` role. |
| **Assignment — Whitelist mode** | When SSM parameter `SIGNUP_MODE_PARAM` = `"whitelist"`, the trigger looks up the email in a DynamoDB whitelist table and assigns the `canonical_role` found there. Falls back to `student` if not found. |
| **Assignment — Public mode** | All subsequent users default to `student` role. |
| **Escalation paths** | Admins can elevate users via `PUT /admin/user_role` (add/remove any role) and `POST /admin/elevate_instructor` (add instructor role). No self-service role change exists for non-admin users. |
| **Role revocation** | Admins use `PUT /admin/user_role` with `operation: "remove"`. Removing the `instructor` role also deletes all `instructor_students` assignments. Cannot remove a user's only role. |

#### Handler-Level Authorization (`authorization.js`)

The `authorization.js` utility provides object-level (BOLA) protection via four permission models:

| Permission Model | Access Rule |
|-----------------|-------------|
| `OWNER_ONLY` | Only the case owner (`student_id`) can access |
| `OWNER_OR_INSTRUCTOR` | Case owner OR an instructor assigned to that student via `instructor_students` table |
| `INSTRUCTOR_ONLY` | Only assigned instructors (explicitly excludes the case owner) |
| `ADMIN_ONLY` | Only admins (not currently used in handler code — role enforced at authorizer layer) |

Both `authorizeCaseAccess` and `authorizeObjectAccess` functions:
- Accept the `userId` from the authorizer context (trusted, not user-supplied)
- Query the database for case ownership (`cases.student_id`) and instructor assignment (`instructor_students`)
- Return structured `{authorized, reason}` responses
- Handle errors defensively, defaulting to deny

#### Authorizer Context Passthrough

Each Lambda authorizer returns an IAM policy with a `context` object containing:
```json
{
  "userId": "<database user_id>",
  "email": "<user_email>",
  "firstName": "<first_name>",
  "lastName": "<last_name>",
  "roles": "[\"admin\"]"  // JSON-stringified array
}
```

Handlers extract this via `event.requestContext.authorizer.userId` — the userId is authorizer-provided and cannot be manipulated by the client.

### Analysis

#### Authorization Enforcement Chain

The platform implements a three-layer defense:

**Layer 1: API Gateway Route Security (OpenAPI spec)**

Each path in `OpenAPI_Swagger_Definition.yaml` binds a `security` field to the appropriate authorizer:

| Path Prefix | Security Scheme | Authorizer Lambda |
|-------------|----------------|-------------------|
| `/admin/*` | `adminAuthorizer` | `adminAuthorizerFunction.js` |
| `/instructor/*` | `instructorAuthorizer` | `instructorAuthorizerFunction.js` |
| `/student/*` | `studentAuthorizer` | `studentAuthorizerFunction.js` |

All three authorizers share identical architecture:
- 60-second result cache TTL (`authorizerResultTtlInSeconds: 60`)
- Token-type `apiKey` in header (API Gateway custom authorizer pattern)
- The cache key is the `Authorization` token value itself

**Layer 2: Lambda Authorizer Role Validation**

Each authorizer enforces role membership at the database level:

```
1. Verify JWT (CognitoJwtVerifier — ID token, sub claim)
2. Query database: SELECT user_id, roles FROM users WHERE idp_id = $sub
3. Check roles array includes required role (e.g., "admin")
4. If role missing: force-refresh cache from DB, re-check (stale-cache mitigation)
5. Return scoped IAM policy: e.g., "*/*/admin/*" for admin authorizer
```

**Scoped IAM policy resources:**
- Admin authorizer returns: `{stage}/*/admin/*`
- Instructor authorizer returns: `{stage}/*/instructor/*`
- Student authorizer returns: `{stage}/*/student/*`

This scoping ensures a cached admin policy cannot be replayed against `/instructor/*` or `/student/*` routes.

**Layer 3: Handler-Level Authorization (BOLA Prevention)**

| Handler | BOLA Protection | Implementation |
|---------|----------------|----------------|
| `adminFunction.js` | **No object-level checks** — admin has platform-wide access. Does verify `roles.includes("admin")` redundantly from authorizer context. | Double-checks admin role from authorizer-provided `roles` JSON. No `authorizeCaseAccess` calls. |
| `instructorFunction.js` | **Yes** — uses `authorizeCaseAccess` with `INSTRUCTOR_ONLY` and `OWNER_OR_INSTRUCTOR` models | Validates instructor is assigned to the student before accessing case data. Does NOT redundantly check role (relies on authorizer). |
| `studentFunction.js` | **Yes** — extensive use of `authorizeCaseAccess` and `authorizeObjectAccess` with `OWNER_ONLY` and `OWNER_OR_INSTRUCTOR` models | Validates ownership on case access, summary deletion, message access, audio files, transcriptions, notes, reviews, and archives. |

**Enforcement consistency summary:**

| Endpoint Category | Layer 1 (API GW) | Layer 2 (Authorizer) | Layer 3 (Handler) |
|-------------------|:-:|:-:|:-:|
| Admin management | ✅ `adminAuthorizer` | ✅ admin role check | ✅ redundant role check |
| Admin role elevation | ✅ `adminAuthorizer` | ✅ admin role check | ⚠️ No self-elevation guard |
| Instructor case operations | ✅ `instructorAuthorizer` | ✅ instructor role check | ✅ BOLA via `authorizeCaseAccess` |
| Student case operations | ✅ `studentAuthorizer` | ✅ student role check | ✅ BOLA via `authorizeCaseAccess` |
| Student object operations | ✅ `studentAuthorizer` | ✅ student role check | ✅ BOLA via `authorizeObjectAccess` |

#### Unprotected Endpoints

**OPTIONS (CORS Preflight) Requests:**

All routes define an `options` method as a mock integration returning CORS headers. These have **no `security` declaration**, which is correct and expected — CORS preflight requests are unauthenticated per the HTTP specification (browsers do not attach credentials to preflight requests).

Count: ~50+ OPTIONS handlers across all path prefixes. This is not a security concern.

**Health Check Endpoints:**

| Endpoint | Security | Risk |
|----------|----------|------|
| `GET /admin/health` | ✅ `adminAuthorizer` | Low — authenticated health check |
| `GET /instructor/health` | ✅ `instructorAuthorizer` | Low — authenticated health check |
| `GET /student/health` | ✅ `studentAuthorizer` | Low — authenticated health check |

All health checks require authentication. This is a defense-in-depth positive — no unauthenticated endpoint exists for reconnaissance.

**Public Paths:**

The OpenAPI specification defines **no publicly accessible paths** (no routes without a `security` field on non-OPTIONS methods). Every functional endpoint is protected by one of the three role-based authorizers.

**Assessment:** The API surface has comprehensive security scheme coverage. No functional endpoint is unprotected.

#### Horizontal Privilege Escalation

**Assessment: LOW RISK — Strong BOLA protections consistently enforced.**

Horizontal privilege escalation (student A accessing student B's data) is well-protected by the architecture's reliance on authorizer-provided identity and handler-level BOLA checks.

**Identity Trust Chain:**

1. The Lambda authorizer extracts the `sub` claim from the verified JWT, resolves it to a database `user_id`, and passes this as `context.userId` in the IAM policy response.
2. API Gateway injects this into `event.requestContext.authorizer.userId` — a value the client cannot tamper with.
3. Handlers extract `userId` from this trusted context and use it for all data-scoping queries.

**Student Handler (`studentFunction.js`) — Parameter Manipulation Resistance:**

| Endpoint | Parameter Checked | Protection Mechanism | Manipulation Risk |
|----------|-------------------|---------------------|-------------------|
| `GET /student/get_cases` | — | Queries `WHERE student_id = ${user_id}` using authorizer userId | **None** — no user-supplied userId accepted |
| `GET /student/case_page` | `case_id` (query param) | `authorizeCaseAccess(user_id, case_id, OWNER_OR_INSTRUCTOR)` | **None** — ownership validated via DB lookup |
| `PUT /student/notes` | `case_id` (query param) | `authorizeCaseAccess(user_id, case_id, OWNER_ONLY)` | **None** — strict owner check |
| `DELETE /student/delete_summary` | `summary_id` (query param) | `authorizeObjectAccess(user_id, summaryId, "summaries", OWNER_ONLY)` | **None** — resolves object to case, validates ownership |
| `GET /student/transcription` | `audio_file_id` (query param) | `authorizeObjectAccess(user_id, audioFileId, "audio_files", OWNER_OR_INSTRUCTOR)` | **None** — validated through object→case→owner chain |
| `PUT /student/edit_case` | `case_id` (query param) | `authorizeCaseAccess(user_id, case_id, OWNER_ONLY)` | **None** — strict owner check |
| `PUT /student/review_case` | `case_id` + `reviewer_ids` (body) | Case ownership validated; reviewer_ids are inserted into junction table (no read access granted by this call alone) | **Low** — reviewer_ids from body are UUIDs for case_reviewers insert, not used for data reads |

**Key Strength:** The `authorizeCaseAccess` function performs a database lookup of `cases.student_id` and compares against the trusted authorizer-provided `userId`. A student cannot supply another student's `user_id` as a parameter to bypass this check because the identity is authorizer-derived, not client-derived.

**One Nuance — `reviewer_ids` in Review Case:**

The `PUT /student/review_case` endpoint accepts `reviewer_ids` in the request body. A student could supply arbitrary UUIDs here, but the impact is limited: these are inserted into `case_reviewers` (a junction table for notification targeting), and the endpoint validates case ownership first. A malicious student could only assign reviewers to their own case, which is the intended behavior.

**Instructor Handler (`instructorFunction.js`) — Cross-Student Isolation:**

The instructor handler consistently uses the authorizer-provided `user.user_id` as the instructor identity:
- `GET /instructor/students` — queries `instructor_students WHERE instructor_id = ${userId}`, returning only assigned students.
- `GET /instructor/view_students` — first fetches `student_ids` from `instructor_students` for the authenticated instructor, then scopes all case queries to those IDs.
- `PUT /instructor/send_feedback` — uses `authorizeCaseAccess` with `INSTRUCTOR_ONLY` to validate assignment before allowing feedback.
- `DELETE /instructor/delete_case` — uses `authorizeCaseAccess` with `OWNER_OR_INSTRUCTOR` to validate relationship.

**Assessment:** An instructor cannot access students assigned to other instructors because all data queries are scoped through the `instructor_students` assignment table, using the trusted authorizer userId as the instructor_id filter.

**Admin Handler (`adminFunction.js`) — Unrestricted by Design:**

The admin handler has no object-level (BOLA) checks. This is intentional: admins are platform superusers with full data access for management operations. The risk is that a compromised admin session provides unrestricted access (see AUTH-RBAC-04).

#### Vertical Privilege Escalation

**Assessment: LOW-MEDIUM RISK — Minimal vertical escalation paths exist, with some timing windows.**

Vertical privilege escalation (lower-privileged user gaining higher-privileged access) is evaluated across four attack vectors:

**1. Cache Timing Exploitation:**

| Attack Scenario | Feasibility | Mitigation |
|-----------------|-------------|-----------|
| User receives instructor role, accesses admin endpoints within 60s cache window | **Not feasible** — the API Gateway cache key is per-token. A new role grant does not change the existing cached Allow policy for `/student/*`. The user would need a fresh token (re-login) or the cache would expire. The cached student authorizer response only allows `*/*/student/*` resources. | IAM policy resource scoping prevents cross-role replay |
| Admin revokes user's role, user continues access for 60s | **Feasible** — the cached Allow policy remains valid for up to 60 seconds. | Accepted risk (see Section 3 analysis). Maximum window: 60 seconds. |
| Attacker obtains cached admin authorizer policy hash | **Not feasible** — API Gateway cache is internal; clients cannot read or inject cached policies. | API Gateway architecture |

**2. Self-Service Role Manipulation:**

No self-service role manipulation endpoint exists for non-admin users. The only role modification endpoints are:
- `PUT /admin/user_role` — protected by `adminAuthorizer` + handler-level `roles.includes("admin")` check
- `POST /admin/elevate_instructor` — protected by `adminAuthorizer` + handler-level admin role check
- `POST /admin/lower_instructor` — protected by `adminAuthorizer` + handler-level admin role check

A student or instructor user has no API endpoint available to modify their own role. The database `roles` column cannot be written via any non-admin endpoint.

**3. Admin Role Elevation Endpoint Safeguards:**

**`PUT /admin/user_role`** — Self-elevation assessment:
- ✅ Validates role is one of `["admin", "instructor", "student"]`
- ✅ Validates operation is one of `["add", "remove"]`
- ✅ Prevents removing a user's only role
- ✅ Cleans up `instructor_students` assignments when removing instructor role
- ⚠️ **No self-operation guard** — An admin can add/remove roles on their own account. Impact: limited, since the user is already admin. However, a compromised admin account could add admin role to a secondary attacker-controlled account.
- ⚠️ **No audit trail** — Role changes are not logged to a separate audit table. The only evidence is CloudWatch Lambda logs (ephemeral, could be tampered with if the attacker has AWS console access).

**`POST /admin/elevate_instructor`** — Safeguards:
- ✅ Verifies target user exists in database
- ✅ Checks if user already has instructor/admin role (no-op if so)
- ⚠️ **Replaces student role with instructor role** (`role === "student" ? "instructor" : role`). This means a user loses their student role when elevated, rather than gaining an additional role. This may be intentional (role transition) but differs from `PUT /admin/user_role` which appends.
- ⚠️ **No self-elevation guard** — An admin could elevate themselves, though this is redundant since admins already have higher privileges.

**4. Database Role Integrity:**

The PostgreSQL `user_role` enum type restricts valid role values to `admin`, `instructor`, `student`. Even if a SQL injection were possible (it is not — tagged templates are used throughout), an attacker could not create an arbitrary super-role.

#### WebSocket Authorization Model

**Assessment: MEDIUM RISK — $connect-only enforcement with limited message-level RBAC creates a role revocation gap for active connections.**

**Authorization Architecture:**

| Stage | Enforcement | Mechanism |
|-------|-------------|-----------|
| `$connect` | ✅ Full JWT validation + role resolution | `wsAuthorizer.js` — same pattern as REST authorizers (JWT verify, DB lookup, role check) |
| `$default` (messages) | ⚠️ Partial role check from cached context | `default.js` — uses `event.requestContext.authorizer.*` passed from `$connect` time |
| `$disconnect` | ❌ No authorization (cleanup only) | `disconnect.js` — removes DynamoDB connection record |

**How WebSocket Context Propagation Works:**

1. At `$connect`, the WebSocket authorizer validates the token, resolves the user from the database, and returns an Allow policy with user context (userId, email, roles).
2. API Gateway caches this authorization result for the lifetime of the WebSocket connection.
3. On subsequent `$default` messages, API Gateway injects the **original** authorization context into `event.requestContext.authorizer` — this is the snapshot from `$connect` time.
4. The `default.js` handler reads `roles` from this context and uses it for message-level decisions.

**Message-Level RBAC in `default.js`:**

The default handler performs role-based access control for specific actions:

| Action | RBAC Check | Enforcement |
|--------|-----------|-------------|
| `generate_text` | None — all authenticated users | Passes `userId` to downstream text generation Lambda (which has its own case ownership validation) |
| `playground_test` | `if (!isStaff)` → 403 | Checks `roles.includes("admin") \|\| roles.includes("instructor")` from authorizer context |
| `playground_assess` | `if (!isStaff)` → 403 | Same staff check |
| `assess_progress` | None — all authenticated users | Passes userId to downstream Lambda |
| `generate_summary` | None — all authenticated users | Passes userId to downstream Lambda |
| `audio_to_text` | None — all authenticated users | Passes userId to downstream Lambda |
| `ping` | None | Heartbeat, no data access |

**Role Revocation Impact on Active Connections:**

When an admin revokes a user's role in the database:
1. The WebSocket connection remains alive (no automatic disconnect).
2. The `event.requestContext.authorizer.roles` in `$default` still reflects the **old** roles from `$connect` time.
3. The revoked user retains WebSocket access with their original role claims until:
   - The connection TTL expires (2-hour DynamoDB TTL set at connect time)
   - The connection is closed by the client
   - API Gateway's 10-minute idle timeout triggers
   - API Gateway's 2-hour maximum connection duration limit is reached

**Impact Assessment:**

| Scenario | Impact | Duration |
|----------|--------|----------|
| Student role revoked, active WebSocket | Student can continue sending `generate_text` messages — but downstream text generation Lambda validates case ownership independently via its own DB lookup | Up to 2 hours (API Gateway max connection duration) |
| Instructor role revoked, active WebSocket | Former instructor retains `playground_test`/`playground_assess` access via cached role context | Up to 2 hours |
| Admin → student demotion, active WebSocket | Demoted user retains admin-level WebSocket actions (`playground_test`) via cached role context | Up to 2 hours |

**No Active Connection Termination Mechanism:**

The platform stores connection records in DynamoDB (with a 2-hour TTL) but has no mechanism to proactively disconnect a user when their role is revoked. API Gateway WebSocket API does not support server-initiated disconnection by connectionId without a management API call (`@connections/{connectionId}` DELETE).

**Mitigating Factor:** For `generate_text` (the primary student action), the downstream text generation Lambda performs its own authorization by looking up the case and validating ownership. A revoked student would still be blocked from accessing cases they don't own. However, a revoked user could potentially continue using their own cases via WebSocket even after their account is deactivated.

#### Instructor-Student Relationship Enforcement

**Assessment: STRONG — Assignment relationship consistently validated before data access.**

The instructor-student relationship is enforced through the `instructor_students` junction table in PostgreSQL. Every instructor endpoint that accesses student data validates this relationship.

**Relationship Enforcement Matrix:**

| Instructor Endpoint | Validation Method | Query Pattern | Can Access Unassigned Students? |
|--------------------|--------------------|---------------|---:|
| `GET /instructor/students` | Direct assignment query | `WHERE instructor_id = ${userId}` | ❌ No |
| `GET /instructor/view_students` | Pre-filters student_ids from assignments | `SELECT student_id FROM instructor_students WHERE instructor_id = ${instructorId}` then `WHERE student_id = ANY(${studentIds})` | ❌ No |
| `GET /instructor/cases_to_review` | Uses `case_reviewers` join (explicit case assignment) | `JOIN case_reviewers cr ON c.case_id = cr.case_id WHERE cr.reviewer_id = ${instructorUserId}` | ❌ No — only cases explicitly assigned for review |
| `PUT /instructor/send_feedback` | `authorizeCaseAccess` with `INSTRUCTOR_ONLY` | Queries `instructor_students` table | ❌ No |
| `DELETE /instructor/delete_case` | `authorizeCaseAccess` with `OWNER_OR_INSTRUCTOR` | Queries `instructor_students` table | ❌ No |
| `PUT /instructor/archive_case` | `authorizeCaseAccess` with `OWNER_OR_INSTRUCTOR` | Queries `instructor_students` table | ❌ No |
| `PUT /instructor/unarchive_case` | `authorizeCaseAccess` with `OWNER_OR_INSTRUCTOR` | Queries `instructor_students` table | ❌ No |
| `GET /instructor/name` | JOIN on `instructor_students` in query | `INNER JOIN instructor_students i ON i.student_id = u.user_id WHERE ... i.instructor_id = ${user.user_id}` | ❌ No |
| `DELETE /instructor/delete_feedback` | Author check (own messages only) | `WHERE instructor_id = ${instructorId}` on the messages table | N/A — checks authorship, not assignment |
| `GET /instructor/prompts` | No student data accessed | Reads `prompt_versions` table (system-wide config) | N/A — not student data |

**Cross-Instructor Isolation:**

An instructor CANNOT access students assigned to other instructors because:
1. The `instructor_students` table enforces a many-to-many relationship between instructors and students.
2. Every data query filters on `instructor_id = ${authenticatedUserId}` where the instructor ID comes from the trusted authorizer context.
3. The `authorizeCaseAccess` function with `INSTRUCTOR_ONLY` or `OWNER_OR_INSTRUCTOR` models queries `instructor_students WHERE instructor_id = ${userId} AND student_id = ${caseOwnerId}` — the instructor must be explicitly assigned to the student who owns the case.

**Student Authorizer Cross-Role Access:**

The student authorizer (`studentAuthorizerFunction.js`) has a deliberate carve-out for instructor access to student endpoints:

```javascript
const instructorCaseRoutes = new Set([
  "GET /student/case_page",
  "GET /student/get_transcriptions",
  "GET /student/transcription",
  "GET /student/get_summaries",
  "GET /student/feedback",
  "GET /student/get_messages",
  "GET /student/file_size_limit",
]);
```

Instructors are allowed through the student authorizer for these routes, but the **handler-level** BOLA checks still enforce the `instructor_students` relationship. An instructor who passes the authorizer will be denied at the handler level if they attempt to access a case belonging to an unassigned student.

**One Edge Case — `OWNER_OR_INSTRUCTOR` Permission Model:**

Some student endpoints use `OWNER_OR_INSTRUCTOR` which grants access to both the case owner AND any assigned instructor. This is the intended behavior for shared viewing (instructors reviewing student work). However, it means that if an admin assigns an instructor to a student and then removes the assignment, the instructor loses access on the next request (the `instructor_students` row is deleted, so the join fails).

**Strength:** No cached assignment data exists in the handler — every request queries the `instructor_students` table fresh, meaning assignment revocation takes effect immediately (unlike role revocation which has a 60-second API Gateway cache window).

### Findings

| ID | Finding | Severity | Effort | Status |
|----|---------|----------|--------|--------|
| AUTH-RBAC-01 | **Admin self-elevation not prevented** — The `PUT /admin/user_role` endpoint allows any admin to add the admin role to any user (including themselves to strengthen their position) or to other accounts they control. No check prevents an admin from operating on their own record. While admins are trusted, a compromised admin account could elevate a secondary attacker-controlled account to admin. | Medium | Low | New |
| AUTH-RBAC-02 | **First-user-admin race condition** — `addStudentOnSignUp.js` determines the first user via `SELECT COUNT(*) FROM users`. Two simultaneous post-confirmation triggers could both observe `count = 0` and both receive admin role. No transaction isolation or advisory lock is used. | High | Medium | New |
| AUTH-RBAC-03 | **Instructor handler missing redundant role check** — Unlike `adminFunction.js` which verifies `roles.includes("admin")` at the handler level, `instructorFunction.js` does not verify `roles.includes("instructor")`. It relies entirely on the Lambda authorizer. While the authorizer enforces this, a defense-in-depth gap exists: if the authorizer were misconfigured or bypassed, the handler would proceed without role validation. | Low | Low | New |
| AUTH-RBAC-04 | **No BOLA checks in admin handler** — `adminFunction.js` does not use `authorizeCaseAccess` or any object-level authorization. Admins have implicit platform-wide access to all data. While this may be intentional (admin = superuser), it means a compromised admin session has unrestricted data access with no audit boundary. | Low | Medium | New |
| AUTH-RBAC-05 | **Post-confirmation trigger returns success on DB failure** — `addStudentOnSignUp.js` returns the event (success) even when the database write fails. This creates a user confirmed in Cognito but unprovisioned in the database. The authorizer will subsequently fail with "User not found" for this user, but the user exists in Cognito and could be confused as to why login fails. No retry or DLQ mechanism exists. | High | Medium | New |
| AUTH-RBAC-06 | **WebSocket role revocation gap — up to 2 hours of stale access** — When a user's role is revoked, active WebSocket connections retain the original role claims from `$connect` time in `event.requestContext.authorizer`. A demoted admin/instructor retains elevated WebSocket privileges (playground access) until the connection closes or API Gateway's 2-hour max duration is reached. No server-initiated disconnect mechanism exists. | Medium | Medium | New |
| AUTH-RBAC-07 | **No message-level case ownership validation in WebSocket default handler** — The `default.js` handler passes `userId` and `case_id` to downstream Lambdas (text generation, summary, audio) without performing its own BOLA check. Security relies entirely on downstream Lambdas validating ownership. If a downstream Lambda lacks this check, the WebSocket could bypass REST-level BOLA enforcement. | Medium | Medium | New |
| AUTH-RBAC-08 | **No audit trail for admin role changes** — `PUT /admin/user_role` and `POST /admin/elevate_instructor` modify user privileges without writing to a dedicated audit table. The only evidence is CloudWatch Lambda logs, which are ephemeral and could be deleted by an attacker with AWS console access. | Medium | Medium | New |
| AUTH-RBAC-09 | **elevate_instructor replaces student role instead of appending** — `POST /admin/elevate_instructor` uses `role === "student" ? "instructor" : role` mapping which removes the student role when adding instructor. This differs from `PUT /admin/user_role` which appends. A re-elevated user loses student-level access to their own cases unless the student authorizer's `instructorCaseRoutes` allowlist covers the needed endpoints. | Low | Low | New |

### Recommendations

1. **AUTH-RBAC-02 (First-user race condition):** Replace the `SELECT COUNT(*)` pattern with an advisory lock or `INSERT ... ON CONFLICT` using a sentinel row in a `system_config` table. Alternatively, use a pre-seeded admin account during deployment and remove the first-user logic entirely for production environments.

2. **AUTH-RBAC-05 (DB failure handling):** Implement a dead-letter queue or retry mechanism for failed post-confirmation database writes. Consider using a Step Functions state machine or SQS queue to retry provisioning, and add a `/student/profile` endpoint that detects the missing database record and triggers re-provisioning.

3. **AUTH-RBAC-03 (Instructor role check):** Add a redundant `roles.includes("instructor")` check in `instructorFunction.js` handler entry point, mirroring the pattern used in `adminFunction.js`. This is a low-effort defense-in-depth improvement.

4. **AUTH-RBAC-01 (Self-elevation):** Consider adding a constraint that prevents an admin from modifying their own roles via `PUT /admin/user_role`. Require a second admin to make changes to admin accounts (two-person rule for admin operations).

5. **AUTH-RBAC-06 (WebSocket role revocation gap):** Implement proactive connection termination when a role is revoked:

   ```javascript
   // In the role revocation handler (PUT /admin/user_role), after DB update:
   // 1. Query DynamoDB for active connections belonging to the affected user
   // 2. Call API Gateway Management API to close each connection
   const { ApiGatewayManagementApiClient, DeleteConnectionCommand } = require("@aws-sdk/client-apigatewaymanagementapi");
   
   async function disconnectUser(userId, wsEndpoint, connectionTableName) {
     const dynamodb = new DynamoDBClient({});
     const connections = await dynamodb.send(new QueryCommand({
       TableName: connectionTableName,
       IndexName: "GSI1",
       KeyConditionExpression: "GSI1PK = :pk",
       ExpressionAttributeValues: { ":pk": { S: `USER#${userId}` } },
     }));
     
     const apigw = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });
     for (const conn of connections.Items || []) {
       try {
         await apigw.send(new DeleteConnectionCommand({
           ConnectionId: conn.connectionId.S,
         }));
       } catch (e) { /* connection may already be closed */ }
     }
   }
   ```

6. **AUTH-RBAC-07 (WebSocket BOLA):** Add case ownership validation in `default.js` before invoking downstream Lambdas for `generate_text`, `generate_summary`, and `audio_to_text` actions. Use the same `authorizeCaseAccess` utility already available in the codebase. This provides defense-in-depth rather than relying solely on downstream validation.

7. **AUTH-RBAC-08 (Audit trail):** Create a `role_change_audit` table that records: actor userId, target userId, operation (add/remove), role, timestamp, and source endpoint. Insert an audit record in `PUT /admin/user_role` and `POST /admin/elevate_instructor` within the same database transaction as the role change. This provides tamper-resistant evidence of privilege changes.

8. **AUTH-RBAC-09 (Role replacement vs append):** Update `POST /admin/elevate_instructor` to append the instructor role rather than replacing the student role, matching the behavior of `PUT /admin/user_role`:

   ```javascript
   // Current (replaces):
   const newRoles = userRoles.map(role => role === "student" ? "instructor" : role);
   
   // Recommended (appends):
   const newRoles = [...userRoles, "instructor"];
   ```

   This ensures elevated users retain access to their own student-scoped endpoints without relying on the authorizer's `instructorCaseRoutes` allowlist.

---

## 5. Token Lifecycle Assessment

### Current Implementation

The Cognito App Client (`api-stack.ts`) configures short-lived access and ID tokens with explicit TTL settings. Refresh token configuration relies on Cognito defaults. The frontend uses Amplify SDK v6 with `sessionStorage` as the key-value storage backend, and the `signOut()` SDK method (without global option) for logout.

**Token Validity Configuration (from `cdk/lib/api-stack.ts`):**

```typescript
this.appClient = this.userPool.addClient(`${id}-pool`, {
  userPoolClientName: userPoolName,
  authFlows: {
    userPassword: true,
    custom: true,
    userSrp: true,
  },
  accessTokenValidity: cdk.Duration.minutes(30),
  idTokenValidity: cdk.Duration.minutes(30),
  // refreshTokenValidity: NOT explicitly configured — Cognito default applies (30 days)
});
```

**Frontend Amplify Configuration (from `frontend/src/App.tsx`):**

```typescript
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { sessionStorage as amplifySessionStorage } from "aws-amplify/utils";

Amplify.configure(amplifyConfig);
cognitoUserPoolsTokenProvider.setKeyValueStorage(amplifySessionStorage);
```

**Logout Implementation (from header components):**

```typescript
import { signOut } from "aws-amplify/auth";

const handleSignOut = async () => {
  try {
    await signOut(); // No { global: true } option — local signout only
    window.location.href = "/";
  } catch (error) { /* silent */ }
};
```

**WebSocket Token Lifecycle (from `frontend/src/hooks/useWebSocket.ts`):**

The WebSocket hook passes the ID token via the `Sec-WebSocket-Protocol` header at connection time. It implements proactive token rotation — scheduling a forced reconnection 30 seconds before the token's `exp` claim:

```typescript
// Token rotation: reconnect before JWT expiry
const rotateLeadMs = 30 * 1000;
const delay = Math.max(expiryMs - Date.now() - rotateLeadMs, 0);
tokenRotationTimeoutRef.current = window.setTimeout(() => {
  forceReconnect();
}, delay);
```

On reconnect, a fresh token is obtained via `fetchAuthSession()` before establishing the new WebSocket connection.

**Source Files:**
- `cdk/lib/api-stack.ts` — App Client token validity settings (lines ~280-290)
- `frontend/src/App.tsx` — Amplify configuration and session storage binding (lines 58-60)
- `frontend/src/pages/Login.tsx` — Authentication flow (signIn, signUp, confirmSignUp, resetPassword)
- `frontend/src/components/AdminHeader.tsx` (also AdvocateHeader, SupervisorHeader) — Logout implementation
- `frontend/src/hooks/useWebSocket.ts` — WebSocket token lifecycle and rotation

### Analysis

#### Token Validity Configuration

**Access Token TTL (30 minutes):** Appropriate for the platform's security posture. The 30-minute window limits the exposure time if a token is intercepted. For a legal content platform, this is a reasonable balance between security and user experience — users will not be frequently interrupted by re-authentication during typical work sessions.

**ID Token TTL (30 minutes):** Matches the access token TTL. Since the platform uses ID tokens (not access tokens) for API authorization, this is the effective session validity window before refresh is required. The 30-minute duration is within OWASP recommendations for sensitive applications.

**Refresh Token TTL (Cognito default — 30 days):** The CDK code does not explicitly set `refreshTokenValidity`, so Cognito applies its default of 30 days. This is **excessively long** for a platform handling privileged legal content. A stolen refresh token grants an attacker persistent access for up to 30 days, even if the user changes their password (unless the refresh token is explicitly revoked). For comparison:
- Banking applications: 15 minutes to 1 hour
- Healthcare applications: 8-24 hours
- General SaaS: 7 days
- **Recommendation for legal platform:** 7 days maximum, ideally 24-72 hours for admin/instructor roles

#### Refresh Token Rotation

**Token Revocation Configuration:** The CDK code does not explicitly enable `enableTokenRevocation` on the App Client. In Cognito CDK v2, token revocation is **enabled by default** (since CDK v2.56.0). This means:

- When a refresh token is used, the old refresh token is revoked (single-use enforcement)
- Cognito tracks refresh token lineage and can revoke all tokens in a family if reuse is detected
- The Amplify SDK v6 handles this transparently — on token refresh, it stores the new refresh token and discards the old one

**Stolen Token Risk Assessment:**

| Scenario | Risk Level | Mitigation |
|---|---|---|
| Refresh token stolen before use | High — attacker has 30-day access window | Short TTL would mitigate; rotation detects reuse |
| Refresh token stolen after use (already rotated) | Low — token already revoked by rotation | Token revocation (default enabled) handles this |
| Both user and attacker use the same refresh token | Medium — reuse detection triggers family revocation | Effective only if user actively uses the app |
| Refresh token stolen via XSS | High — sessionStorage accessible to JS | CSP and XSS prevention are the primary defenses |

**Gap:** While token revocation is enabled by default, there is no explicit verification of this in the CDK configuration. The implicit reliance on default behavior is fragile — a CDK version change or explicit override could silently disable rotation.

#### Session Invalidation Capabilities

**Admin Force-Logout:** No admin-initiated force-logout capability exists in the current implementation. The platform does not expose:
- Cognito `AdminUserGlobalSignOut` API — would invalidate all refresh tokens for a user
- Cognito `GlobalSignOut` API — user-initiated global signout
- Custom session invalidation endpoint

**Role Revocation Propagation:**

The timeline from role revocation to effective access denial:

1. **Database role update:** Immediate (admin changes role in PostgreSQL)
2. **API Gateway authorizer cache:** Up to 60 seconds (cached Allow policy continues granting access)
3. **Lambda `userMetadataCache`:** Until execution context recycle (potentially hours — see AUTH-LA-01)
4. **Frontend session:** Until next API call fails or token refresh cycle

**Total worst-case window:** A revoked user may retain access for the authorizer cache TTL (60s) on API calls that hit a warm Lambda with a stale cache entry. In practice, the authorizer cache is the binding constraint since it operates at the API Gateway level before the Lambda is even invoked.

**No "logout everywhere" support:** The platform cannot force-disconnect a user's active sessions across devices. The `signOut()` call is local-only (clears browser storage) and does not invoke Cognito's server-side revocation.

#### Logout Implementation

**Current Behavior:**

1. `signOut()` from `aws-amplify/auth` is called **without** the `{ global: true }` option
2. This performs a **local-only** signout:
   - Clears tokens from `sessionStorage`
   - Does NOT call Cognito's `RevokeToken` or `GlobalSignOut` endpoint
   - Does NOT invalidate the refresh token server-side
3. After clearing storage, `window.location.href = "/"` forces a page reload (clearing in-memory state)

**Security Implications:**

- **Tokens remain valid server-side after logout:** A captured token (via network intercept, XSS, or browser extension) continues to authenticate API requests until the 30-minute TTL expires.
- **Refresh token not revoked:** If an attacker obtained the refresh token before logout, they can continue refreshing access for up to 30 days.
- **No backend cache invalidation:** The API Gateway authorizer cache (60s TTL) and Lambda `userMetadataCache` are not informed of the logout event.

**Amplify SDK `signOut({ global: true })` would:**
- Call Cognito's `GlobalSignOut` API
- Revoke all refresh tokens for the user
- Invalidate all sessions across all devices
- This is not currently used.

#### Frontend Token Storage

**Storage Mechanism:**

The application explicitly configures Amplify SDK v6 to use `sessionStorage`:

```typescript
cognitoUserPoolsTokenProvider.setKeyValueStorage(amplifySessionStorage);
```

This means:
- **Access token, ID token, and refresh token** are stored in `window.sessionStorage`
- Tokens are accessible via JavaScript (`sessionStorage.getItem(...)`)
- Tokens persist for the browser tab/window lifecycle (cleared when tab is closed)
- Tokens do NOT persist across browser restarts or new tabs

**XSS Vulnerability Assessment:**

| Factor | Status | Impact |
|---|---|---|
| sessionStorage accessible to JS | Yes | XSS can read all tokens |
| httpOnly cookies used | No | Tokens are not protected from JS access |
| Content Security Policy | Partial — configured in `vite.config.ts` dev server only | Production CSP depends on Amplify hosting/CDN headers |
| CSP includes `'unsafe-inline'` for scripts | Yes — dev config | Weakens XSS protection in development |
| React's built-in XSS protection | Yes | JSX auto-escapes by default |

**Key observation:** The `sessionStorage` choice is **more secure than `localStorage`** (Amplify's default) because tokens don't persist across tabs or browser restarts. However, tokens are still accessible to any JavaScript running in the page context. A successful XSS attack could exfiltrate all three tokens (access, ID, and refresh).

**CSP Configuration (from `frontend/vite.config.ts`):**

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; 
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; 
  connect-src 'self' wss: https:; frame-ancestors 'none';
```

The `'unsafe-inline'` and `'unsafe-eval'` directives in `script-src` significantly weaken XSS protection. While these may be needed for React/Vite in development, production should use nonce-based CSP. Additionally, `connect-src 'self' wss: https:` allows connections to any HTTPS/WSS endpoint, which could facilitate data exfiltration.

**Note:** This CSP is configured on the Vite dev server headers. The production CSP depends on Amplify Hosting / CloudFront response headers configuration, which was not found in the CDK stack. If no production CSP is configured, the browser applies no CSP restrictions at all.

#### WebSocket Token Lifecycle

**Relationship to REST Session:**

- WebSocket authentication uses the same Cognito ID token as REST API calls
- The token is passed at `$connect` time via `Sec-WebSocket-Protocol` header
- After connection establishment, no further authentication occurs on message frames
- The WebSocket API Gateway does not re-validate the token on each message

**Token Refresh Impact:**

The `useWebSocket` hook implements a proactive token rotation strategy:

1. On connection establishment, parses the JWT `exp` claim from the token
2. Schedules a `forceReconnect()` 30 seconds before token expiration
3. On reconnect, calls `fetchAuthSession()` to get a fresh token from Amplify SDK (which auto-refreshes via the refresh token)
4. Establishes a new WebSocket connection with the fresh token

**Connection Survival on Expiration:**

- If the proactive rotation timer fires correctly, the connection is closed and re-established before expiry
- If the timer fails (browser tab backgrounded, timer throttled), the connection remains alive with an expired token
- The WebSocket API Gateway does **not** terminate connections with expired tokens — there is no periodic re-authentication
- A connection established with a valid token lives until explicitly closed, the idle timeout fires, or a network interruption occurs

**Gap:** Between the 30-second rotation lead time and the actual reconnection, there's a brief window. If `fetchAuthSession()` fails (e.g., refresh token expired), the connection is lost and `setConnectionState("error")` is set, requiring the user to re-authenticate.

### Findings

| ID | Finding | Severity | Effort | Status |
|----|---------|----------|--------|--------|
| AUTH-TL-01 | **Refresh token TTL defaults to 30 days — excessively long for legal content platform.** The CDK App Client does not explicitly set `refreshTokenValidity`, relying on Cognito's 30-day default. A stolen refresh token provides persistent access for up to 30 days. For a platform handling privileged legal content, this window should be 7 days maximum. | High | Low | New |
| AUTH-TL-02 | **Logout does not revoke server-side tokens — local-only signout.** The `signOut()` call does not pass `{ global: true }`, so Cognito's `GlobalSignOut` is never invoked. Tokens captured before logout remain valid for their full TTL (30 min access/ID, 30 days refresh). An attacker with a stolen refresh token retains access even after the user logs out. | High | Low | New |
| AUTH-TL-03 | **No admin force-logout capability exists.** There is no endpoint or admin UI to invoke `AdminUserGlobalSignOut` for a specific user. If an account is compromised or a user's access must be immediately revoked, the only option is to disable the user in Cognito — which does not invalidate existing tokens until they expire. | Medium | Medium | New |
| AUTH-TL-04 | **No production Content Security Policy configured.** The CSP header is only set in the Vite dev server configuration (`vite.config.ts`). No CDK construct, CloudFront response header policy, or Amplify custom headers configuration was found for production. Without a production CSP, XSS attacks face no browser-level restriction on script execution or data exfiltration, making sessionStorage token theft trivial. | High | Medium | New |
| AUTH-TL-05 | **Development CSP uses `'unsafe-inline'` and `'unsafe-eval'` in script-src.** Even the dev CSP allows inline scripts and eval, which are the primary vectors for XSS exploitation. While acceptable for development, this pattern should not propagate to production. | Medium | Low | New |
| AUTH-TL-06 | **WebSocket connections survive token expiration with no server-side termination.** After the initial `$connect` authentication, the WebSocket API Gateway does not re-validate the token or terminate stale connections. While the frontend implements proactive reconnection 30 seconds before expiry, a backgrounded tab (where timers are throttled) may retain an authenticated connection indefinitely with an expired token. | Medium | Medium | New |
| AUTH-TL-07 | **No idle session timeout implemented.** The platform has no mechanism to detect user inactivity and terminate the session (clear tokens, disconnect WebSocket). A user who walks away from an unlocked workstation with an active session provides an open access window limited only by the tab's lifetime. | Medium | Medium | New |
| AUTH-TL-08 | **Token revocation not explicitly configured — relies on CDK default behavior.** The App Client does not explicitly set `enableTokenRevocation: true`. While CDK v2 enables this by default, relying on implicit defaults for a security-critical feature is fragile. An explicit setting provides defense against CDK behavior changes and documents the security intent. | Low | Low | New |
| AUTH-TL-09 | **`connect-src` CSP directive allows all HTTPS/WSS origins.** The development CSP specifies `connect-src 'self' wss: https:` which permits outbound connections to any HTTPS or WSS endpoint. A successful XSS attack could exfiltrate tokens to an attacker-controlled server without CSP blocking the request. | Medium | Low | New |

### Recommendations

1. **AUTH-TL-01 — Set explicit refresh token TTL (Priority: High, Effort: Low):**

   Add explicit `refreshTokenValidity` to the App Client configuration:

   ```typescript
   this.appClient = this.userPool.addClient(`${id}-pool`, {
     // ... existing config ...
     accessTokenValidity: cdk.Duration.minutes(30),
     idTokenValidity: cdk.Duration.minutes(30),
     refreshTokenValidity: cdk.Duration.days(7), // Max 7 days for legal platform
   });
   ```

   Consider a shorter TTL (24-72 hours) for admin/instructor roles if per-client differentiation is implemented.

2. **AUTH-TL-02 — Enable global signout on logout (Priority: High, Effort: Low):**

   Update all header component `handleSignOut` functions to use global signout:

   ```typescript
   const handleSignOut = async () => {
     try {
       await signOut({ global: true }); // Revokes all refresh tokens server-side
       window.location.href = "/";
     } catch (error) {
       // Fallback to local signout if global fails (e.g., network error)
       await signOut();
       window.location.href = "/";
     }
   };
   ```

3. **AUTH-TL-03 — Implement admin force-logout endpoint (Priority: Medium, Effort: Medium):**

   Add an admin API endpoint that calls `AdminUserGlobalSignOut`:

   ```javascript
   // In adminFunction.js route handler
   "POST /admin/force-logout": async (event) => {
     const { userId } = JSON.parse(event.body);
     const cognito = new CognitoIdentityProviderClient({});
     await cognito.send(new AdminUserGlobalSignOutCommand({
       UserPoolId: process.env.USER_POOL_ID,
       Username: userId, // Cognito username (sub or email)
     }));
     return { statusCode: 200, body: JSON.stringify({ message: "User sessions revoked" }) };
   }
   ```

4. **AUTH-TL-04 / AUTH-TL-05 / AUTH-TL-09 — Configure production CSP (Priority: High, Effort: Medium):**

   Add a CloudFront response headers policy via CDK or Amplify custom headers:

   ```typescript
   // In amplify-stack.ts or via Amplify custom headers (amplify.yml)
   customHeaders:
     - pattern: '**'
       headers:
         - key: Content-Security-Policy
           value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://<api-domain> wss://<ws-domain>; frame-ancestors 'none';"
   ```

   Key changes from development CSP:
   - Remove `'unsafe-inline'` and `'unsafe-eval'` from `script-src`
   - Restrict `connect-src` to specific API and WebSocket domains
   - Use nonce-based script loading if inline scripts are needed

5. **AUTH-TL-06 — Implement server-side WebSocket connection pruning (Priority: Medium, Effort: Medium):**

   Options (from simplest to most robust):
   - **Option A:** Reduce API Gateway WebSocket idle timeout to match token TTL (less practical)
   - **Option B:** Implement a scheduled Lambda that queries the connections table for connections older than 30 minutes and calls `@connections` `DELETE` to terminate them
   - **Option C:** Add periodic re-authentication messages on the WebSocket where the client must send a fresh token

6. **AUTH-TL-07 — Add frontend idle timeout (Priority: Medium, Effort: Medium):**

   Implement an inactivity detector that triggers signout after a configurable period:

   ```typescript
   // In App.tsx or a dedicated IdleTimeout component
   const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
   
   useEffect(() => {
     let timer: number;
     const resetTimer = () => {
       clearTimeout(timer);
       timer = window.setTimeout(() => {
         signOut({ global: true });
         window.location.href = "/";
       }, IDLE_TIMEOUT_MS);
     };
     
     const events = ["mousedown", "keydown", "scroll", "touchstart"];
     events.forEach(e => document.addEventListener(e, resetTimer));
     resetTimer();
     
     return () => {
       clearTimeout(timer);
       events.forEach(e => document.removeEventListener(e, resetTimer));
     };
   }, []);
   ```

7. **AUTH-TL-08 — Make token revocation explicit (Priority: Low, Effort: Low):**

   ```typescript
   this.appClient = this.userPool.addClient(`${id}-pool`, {
     // ... existing config ...
     enableTokenRevocation: true, // Explicit — documents security intent
   });
   ```

---

## 6. WebSocket Authentication Assessment

### Current Implementation

The WebSocket API (`ChatWebSocket`) provides real-time streaming for AI text generation, summaries, transcription, and playground features. Authentication is enforced at the `$connect` route via a dedicated Lambda authorizer (`wsAuthorizer.js`), which validates a Cognito JWT ID token and resolves the user's identity from the PostgreSQL database before granting connection access.

**Token Extraction Flow (wsAuthorizer.js `extractToken`):**

The authorizer extracts the JWT token using a three-mechanism fallback chain:

1. **Authorization header** — `Bearer <token>` format, standard OAuth 2.0 pattern
2. **Sec-WebSocket-Protocol header** — first comma-separated protocol value is treated as the token
3. **Query string parameter** — `?token=<jwt>` appended to the WebSocket URL

The CDK `identitySource` is configured as `["route.request.header.Sec-WebSocket-Protocol"]`, meaning API Gateway uses this header as the cache key for authorizer result caching.

**JWT Verification:**

- Library: `aws-jwt-verify` (`CognitoJwtVerifier`)
- Token type: ID token (`tokenUse: "id"`)
- Claims verified: `sub` (used as `idpId`), signature, expiration, issuer (`userPoolId`), audience (`clientId`)
- Claims NOT verified: `cognito:groups`, custom attributes

**User Resolution:**

After JWT validation, the authorizer queries the database (`SELECT user_id, user_email, first_name, last_name, roles FROM users WHERE idp_id = $idpId`) and passes user metadata (userId, email, firstName, lastName, roles) to downstream handlers via the IAM policy context object.

**Connection Lifecycle:**

- **`connect.js`** — Stores connection-to-user mapping in DynamoDB with a 2-hour TTL. Enforces a per-user connection limit (`MAX_CONNECTIONS_PER_USER`, default 5). Echoes back the `Sec-WebSocket-Protocol` header if present.
- **`disconnect.js`** — Deletes the DynamoDB connection record for cleanup.
- **`default.js`** — Dispatches messages by `action` field. Uses authorizer context (userId, roles) for identity. Implements message-level RBAC for `playground_test` and `playground_assess` actions (admin/instructor only). Other actions (`generate_text`, `generate_summary`, `audio_to_text`, `assess_progress`) pass userId downstream without role enforcement at this layer.

**Infrastructure Configuration (api-stack.ts):**

- WebSocket stage throttling: `rateLimit: 100` requests/second, `burstLimit: 200`
- No WAF Web ACL association on the WebSocket API (WAF is only associated with the REST API Gateway stage)
- Authorizer Lambda runs in VPC with access to RDS Proxy

**Source Files:**
- `cdk/lambda/authorization/wsAuthorizer.js` — WebSocket authorizer
- `cdk/lambda/websocket/connect.js` — $connect handler
- `cdk/lambda/websocket/disconnect.js` — $disconnect handler
- `cdk/lambda/websocket/default.js` — $default message handler
- `cdk/lib/api-stack.ts` (lines 2355–2398) — WebSocket API CDK construct

### Analysis

#### Token Extraction Methods

The three-mechanism fallback provides flexibility for browser clients (which cannot set custom headers on WebSocket upgrade requests) but introduces security tradeoffs:

1. **Authorization header (Bearer)** — Most secure. Standard pattern, not logged by default in API Gateway access logs, not visible in URL. However, browser-based WebSocket APIs (`new WebSocket(url)`) cannot set custom headers, making this mechanism available only to non-browser clients or libraries that support custom headers during upgrade.

2. **Sec-WebSocket-Protocol header** — The primary browser-compatible mechanism. The token is passed as a "protocol" value, which is architecturally a misuse of the Sec-WebSocket-Protocol header (designed for application-layer protocol negotiation, not credential transport). The `connect.js` handler echoes the entire protocol header back in the response (including the token), which could expose credentials in response headers captured by intermediary logging.

3. **Query string parameter (`?token=`)** — Fallback mechanism that places the JWT directly in the URL. This is the least secure option as URLs are routinely logged across multiple infrastructure layers.

#### Sec-WebSocket-Protocol Token Passing

**Log Exposure Risk:**
- API Gateway access logs can be configured to include request headers. If `$request.header.Sec-WebSocket-Protocol` is included in access log format, the JWT appears in CloudWatch Logs.
- The CDK `identitySource` is set to `route.request.header.Sec-WebSocket-Protocol`, meaning API Gateway uses this header value as the authorizer cache key. The token value is therefore part of the cache key infrastructure.
- WAF (if associated) would see this header in request inspection and could log it in WAF logs.

**Dev Tools Visibility:**
- The Sec-WebSocket-Protocol header is visible in browser developer tools (Network tab → WebSocket connection → Headers). Any user inspecting network traffic sees their full JWT token.
- This is comparable to Bearer token visibility and is acceptable for the user's own session, but differs from httpOnly cookie patterns that hide tokens from JavaScript/DevTools.

**Response Echo Issue:**
- `connect.js` echoes the `Sec-WebSocket-Protocol` header back in the 101 response. This means the JWT token appears in both the request and response headers of the upgrade handshake, doubling log exposure surface.

**Alternative Approaches:**
- The recommended pattern for browser WebSocket auth is: (a) obtain a short-lived, single-use connection ticket via an authenticated REST endpoint, then (b) pass the ticket in the query string or first message. This limits exposure to a narrow time window and single use.
- Another alternative: authenticate via first message after connection (requires unauthenticated $connect with immediate auth challenge).

#### Query String Token Parameter

**Credential Leakage Vectors:**
- **CloudWatch API Gateway access logs** — `$request.querystring` would include the token if the log format captures query parameters
- **VPC Flow Logs** — Do not capture application-layer data (TLS encrypted), so not exposed here
- **CloudTrail** — API Gateway invoke events may include request URL for troubleshooting
- **Browser history** — The full URL with token would appear in browser history if the connection URL is constructed client-side
- **Server-side proxy/CDN logs** — Any L7 proxy between client and API Gateway endpoint would see the full URL
- **Referrer headers** — Not applicable to WebSocket, but if the page URL includes the token via navigation

**Assessment:** The query string fallback represents a credential leakage risk. JWT tokens are long-lived (30 minutes) and contain user identity claims. URL-based token passing should be deprecated in favor of Sec-WebSocket-Protocol (which, while imperfect, is not logged in URL-based log formats).

#### Connection Lifecycle Security

**Idle Timeout:**
- API Gateway WebSocket has a default idle connection timeout of 10 minutes (configurable up to 10 minutes). If no messages are sent for 10 minutes, the connection is automatically closed.
- The `default.js` handler implements a `ping`/`pong` heartbeat mechanism, which can keep connections alive indefinitely by resetting the idle timer.

**Maximum Connection Duration:**
- API Gateway enforces a maximum connection duration of 2 hours. Connections are forcibly closed after this period regardless of activity.
- DynamoDB TTL is set to 2 hours (`2 * 60 * 60` seconds from connection time), aligning with this limit.

**Stale Connection Detection:**
- There is no mechanism to detect or terminate connections where the user's JWT has expired post-`$connect`. Once authorized at connection time, the connection remains valid until disconnect, idle timeout, or the 2-hour maximum.
- If a user's role is revoked in the database after `$connect`, the `default.js` handler continues to use the roles passed in the authorizer context at connection time. The cached context is never refreshed.
- The `lastActivity` field is stored in DynamoDB at connection time but is never updated on subsequent messages, making it ineffective for activity-based timeout decisions.

**Re-authentication:**
- No periodic re-authentication mechanism exists for long-lived connections. A connection established with a valid token at time T remains fully authorized for up to 2 hours, even if the token expires at T+30m or the user's account is suspended.

#### Authorizer Error Handling

**Consistent Deny Policy:**
- The authorizer returns an explicit `Deny` IAM policy on all failure paths (missing token, invalid token, expired token, user not found, database error). This is correct — API Gateway requires either an Allow/Deny policy response or a thrown error to produce a 401/403.
- The catch-all in the handler wraps all errors and produces `generatePolicy("unauthorized", "Deny", methodArn)`.

**Reason Leakage:**
- The logger records `reason: error?.message` in error logs, which could include specific failure reasons ("User not found", JWT validation errors). These are server-side logs only and not returned to the client.
- API Gateway returns a generic 401/403 to the client on Deny, so failure reasons are not leaked to attackers.
- However, the `getUserMetadataFromDatabase` function logs `errorType` and `errorMessage`, which in certain database error scenarios could include SQL-related details in CloudWatch Logs.

**Rate Limiting:**
- WebSocket `$connect` attempts are subject to the stage-level throttling (100 req/s, burst 200), which provides some protection against rapid connection attempts.
- There is no per-IP or per-user rate limiting specific to failed authentication attempts. An attacker could make 100 connection attempts per second with invalid tokens, consuming authorizer Lambda invocations and database connections.
- The authorizer cache (keyed on Sec-WebSocket-Protocol header value) means repeated attempts with the same invalid token would be cached as Deny for the TTL period, but different tokens would each trigger a new Lambda invocation.

#### WAF Web ACL Association

**Current State:**
- The REST API Gateway has a regional WAF Web ACL associated (`${id}-waf`) with rate limiting rules (`LimitRequests2000`, `PerUserRateLimit`), AWS Managed Rules (Common, Known Bad Inputs, Anonymous IP List, IP Reputation), and logging.
- The WebSocket API has **no WAF association**. It relies solely on API Gateway stage throttling (100/200 burst) for traffic management.

**DDoS Risk:**
- Without WAF, the WebSocket API is exposed to:
  - **Connection-level DDoS**: Rapid connect/disconnect cycles consuming Lambda authorizer invocations and database connections
  - **Message flooding**: Once connected, a client can send unlimited messages at the stage rate limit (100/s) without WAF inspection
  - **Credential stuffing via $connect**: Repeated connection attempts with stolen/guessed tokens
- The stage throttling provides a global rate limit but does not differentiate between legitimate and malicious traffic, nor does it provide per-IP limiting.

**Mitigation Gap:**
- AWS WAFv2 supports WebSocket API (`REGIONAL` scope, resource type `AWS::ApiGatewayV2::Api`). The WebSocket API can be associated with a WAF Web ACL.
- The existing REST API WAF rules (IP reputation, rate limiting, known bad inputs) would provide meaningful protection if applied to the WebSocket API.

### Findings

| ID | Finding | Severity | Effort | Status |
|----|---------|----------|--------|--------|
| AUTH-WS-01 | Query string token parameter (`?token=`) exposes JWT credentials in URL, risking leakage via CloudWatch access logs, browser history, and intermediary proxy logs | High | Low | New |
| AUTH-WS-02 | WebSocket API has no WAF Web ACL association, leaving it unprotected against connection-level DDoS, credential stuffing, and IP reputation filtering available on the REST API | High | Low | New |
| AUTH-WS-03 | No re-authentication mechanism for long-lived WebSocket connections; a connection persists up to 2 hours even after token expiration (30 min) or account/role revocation | High | Medium | New |
| AUTH-WS-04 | Sec-WebSocket-Protocol header echo in `connect.js` response exposes JWT token in response headers, doubling log exposure surface | Medium | Low | New |
| AUTH-WS-05 | `default.js` handler uses authorizer context roles cached at $connect time without refresh; role revocation does not propagate to active WebSocket sessions | Medium | Medium | New |
| AUTH-WS-06 | No per-IP or per-user rate limiting on failed WebSocket $connect attempts; an attacker can exhaust authorizer Lambda concurrency and database connections at 100 req/s | Medium | Low | New |
| AUTH-WS-07 | `userMetadataCache` in wsAuthorizer.js grows unbounded across warm Lambda invocations with no TTL, eviction, or size limit; stale entries could grant access to deleted users | Medium | Low | New |
| AUTH-WS-08 | `lastActivity` field written at connection time but never updated on subsequent messages, rendering it ineffective for activity-based idle detection | Low | Low | New |
| AUTH-WS-09 | `generate_text`, `generate_summary`, `audio_to_text`, and `assess_progress` actions lack message-level role enforcement (unlike `playground_test`/`playground_assess` which check isStaff) | Medium | Medium | New |
| AUTH-WS-10 | Sec-WebSocket-Protocol header misuse for credential transport deviates from protocol design intent; token visible in DevTools network tab and potentially in WAF/access logs if WAF is later associated | Low | High | New |

### Recommendations

**Immediate (Low Effort):**

1. **AUTH-WS-01 — Remove query string token fallback:**
   Remove the `queryParams.token` extraction path from `wsAuthorizer.js`. Update client libraries to use Sec-WebSocket-Protocol exclusively. If backward compatibility is required, log a deprecation warning and set a removal date.

   ```javascript
   // Remove this block from extractToken():
   // const queryParams = event.queryStringParameters || {};
   // if (queryParams.token) { return queryParams.token; }
   ```

2. **AUTH-WS-02 — Associate WAF Web ACL with WebSocket API:**
   Create a `CfnWebACLAssociation` targeting the WebSocket API stage ARN. Reuse the existing regional WAF ACL or create a WebSocket-specific one with rate limiting rules.

   ```typescript
   new wafv2.CfnWebACLAssociation(this, `${id}-ws-waf-association`, {
     resourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.wsApi.apiId}/${this.wsStage.stageName}`,
     webAclArn: waf.attrArn,
   });
   ```

3. **AUTH-WS-04 — Stop echoing full protocol header in connect response:**
   Instead of echoing the raw `Sec-WebSocket-Protocol` header (which contains the token), echo a fixed protocol name (e.g., `"chat.v1"`).

   ```javascript
   // In connect.js, replace:
   // response.headers = { "Sec-WebSocket-Protocol": protocolHeader };
   // With:
   response.headers = { "Sec-WebSocket-Protocol": "chat.v1" };
   ```

4. **AUTH-WS-06 — Add per-IP rate limiting for $connect:**
   WAF association (AUTH-WS-02) provides this via the existing `LimitRequests2000` and IP reputation rules. Additionally, consider a stricter per-IP limit for the WebSocket endpoint.

5. **AUTH-WS-07 — Add TTL and size limit to userMetadataCache:**
   ```javascript
   const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
   const MAX_CACHE_SIZE = 1000;

   async function getUserMetadataFromDatabase(idpId) {
     const cached = userMetadataCache[idpId];
     if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
       return cached.data;
     }
     // ... fetch from DB ...
     if (Object.keys(userMetadataCache).length >= MAX_CACHE_SIZE) {
       userMetadataCache = {}; // Simple eviction
     }
     userMetadataCache[idpId] = { data: user, timestamp: Date.now() };
     return user;
   }
   ```

**Next Sprint (Medium Effort):**

6. **AUTH-WS-03 — Implement periodic re-authentication:**
   Add a server-side mechanism to validate connection freshness:
   - Store token expiration time in DynamoDB connection record at $connect
   - In `default.js`, check if the original token's expiration has passed before processing messages
   - If expired, send a `re-authenticate` message to the client requesting a new token via a `refresh_token` action
   - Alternatively, implement a connection TTL shorter than the maximum 2 hours (e.g., equal to token TTL of 30 minutes) and require clients to reconnect

7. **AUTH-WS-05 — Refresh roles from database for sensitive operations:**
   For actions that modify data or access privileged features, re-query the user's current roles from the database rather than relying solely on the authorizer context cached at $connect time.

8. **AUTH-WS-09 — Add role enforcement to all message actions:**
   Ensure `generate_text` validates that the user owns the `case_id`, and `assess_progress`/`generate_summary` validate appropriate role (e.g., instructor or case owner). Consider extracting authorization logic to a shared utility.

**Backlog (High Effort):**

9. **AUTH-WS-10 — Migrate to connection ticket pattern:**
   Replace Sec-WebSocket-Protocol token passing with a short-lived, single-use connection ticket:
   - Client calls `POST /ws/ticket` (authenticated REST endpoint) to obtain a ticket (UUID, 30-second TTL, stored in DynamoDB)
   - Client connects to WebSocket with `?ticket=<uuid>`
   - Authorizer validates ticket existence and TTL, then deletes it (single use)
   - This eliminates long-lived token exposure in WebSocket upgrade headers

---

## 7. Cognito Triggers Assessment

### Current Implementation

Two Cognito User Pool Lambda triggers manage the user registration lifecycle:

**Pre-Signup Trigger (`preSignup.js`):**

This Lambda is invoked before Cognito creates the user record. It enforces registration restrictions through a two-stage validation process:

| Stage | Check | Data Source | Failure Behavior |
|-------|-------|-------------|------------------|
| 1. Domain Validation | Email domain matches allowed list | SSM Parameter `/LAIGO/AllowedEmailDomains` (fetched with `WithDecryption: true`) | Throws `UserError` with domain-specific message |
| 2. Whitelist Check | Exact email exists in whitelist (only when signup mode = `"whitelist"`) | SSM Parameter `/LAIGO/SignupMode` + DynamoDB table `${id}-email-whitelist` | Throws `UserError` with email-specific message |

**Validation Flow:**
1. Retrieve allowed domains from SSM (comma-separated, e.g., `"university.ca,lawfirm.com"`)
2. Parse and lowercase all allowed domains
3. Extract email domain from `event.request.userAttributes.email`
4. Check if domain matches any allowed entry (including wildcard `*` which allows all domains)
5. If `SIGNUP_MODE_PARAM` and `WHITELIST_TABLE_NAME` are configured, retrieve signup mode
6. If mode is `"whitelist"`, query DynamoDB for the exact email (lowercased, trimmed)
7. If the email is found, the whitelist item's `canonical_role` attribute is logged (used later by post-confirmation)
8. On any non-user error (internal failures, missing SSM parameters), return a generic error message

**Error Handling Pattern:**
```javascript
// UserError — shown to user with specific context
throw new UserError(`Signup not allowed for email domain: ${emailDomain}`);
throw new UserError(`Signup not allowed: your email (${email}) is not on the access list.`);

// Internal errors — masked with generic message
throw new Error("An error occurred during signup. Please try again later or contact an administrator.");
```

**Post-Confirmation Trigger (`addStudentOnSignUp.js`):**

This Lambda is invoked after the user confirms their email. It provisions the user record in PostgreSQL:

| Step | Action | Details |
|------|--------|---------|
| 1 | Initialize DB connection | Via `initializeConnection()` using Secrets Manager credentials, RDS Proxy, single connection (`max: 1`), 10s connect timeout |
| 2 | Retrieve user attributes | `AdminGetUser` API call to Cognito for `email`, `given_name`, `family_name`, `sub` |
| 3 | Check existing user | Query `SELECT * FROM users WHERE idp_id = ${idpId} OR user_email = ${email}` |
| 4a | If exists → Update | Update `first_name`, `last_name`, `last_sign_in`, `idp_id` (upsert by email) |
| 4b | If new → Determine role | First user → `admin`; whitelist mode → lookup DynamoDB `canonical_role`; else → `student` |
| 5 | Insert new user | `INSERT INTO users (idp_id, user_email, first_name, last_name, time_account_created, roles, last_sign_in)` |
| 6 | Return event | Always returns `event` (even on error — see below) |

**Role Assignment Logic:**
```
if (first user in system → count = 0):  role = "admin"
else if (signup mode = "whitelist"):
    if (email in DynamoDB whitelist): role = whitelist.canonical_role
    else:                             role = "student" (defensive fallback)
else (public mode):                    role = "student"
```

**CDK Configuration (`cdk/lib/api-stack.ts`, lines 970–1022):**

| Property | Pre-Signup | Post-Confirmation |
|----------|-----------|-------------------|
| Runtime | Node.js 24.x | Node.js 24.x |
| Timeout | 10 seconds | 29 seconds |
| Memory | 128 MB | 256 MB |
| VPC | No (public) | Yes (private subnet with NAT) |
| Security Group | None | `dbClientSg` |
| Layers | Powertools | postgres, Powertools |
| IAM Role | `cognitoRole` (SSM read, DynamoDB GetItem) | `cognitoRole` (+ Secrets Manager, VPC ENI) |

**Source Files:**
- `cdk/lambda/authorization/preSignup.js` — Pre-Signup trigger (domain + whitelist validation)
- `cdk/lambda/authorization/addStudentOnSignUp.js` — Post-Confirmation trigger (user provisioning)
- `cdk/lambda/authorization/initializeConnection.js` — Database connection initialization (Secrets Manager + RDS Proxy)
- `cdk/lib/api-stack.ts` (lines 950–1025) — CDK construct definitions, IAM permissions, environment variables

### Analysis

#### Pre-Signup Trigger Security

**SSM Parameter Encryption:**

The domain allowlist is retrieved using `WithDecryption: true`, indicating it is stored as a SecureString parameter in SSM. This is appropriate — the parameter value (allowed domains) is not highly sensitive, but using SecureString prevents accidental exposure in CloudFormation outputs or SSM parameter listings without IAM permissions.

The signup mode parameter (`/LAIGO/SignupMode`) is retrieved **without** `WithDecryption`, suggesting it is stored as a regular String parameter. This is acceptable as the mode value (`"public"` or `"whitelist"`) is not sensitive.

**Wildcard Domain Bypass Risk:**

The domain check includes support for a wildcard entry:
```javascript
if (allowed === "*") return true;
```

If the SSM parameter `/LAIGO/AllowedEmailDomains` contains `*` (either alone or in the comma-separated list), **all email domains are accepted**, completely bypassing domain-based registration restrictions.

| Risk Factor | Assessment |
|---|---|
| Is wildcard used in production? | Unknown — SSM parameter value is environment-specific and cannot be determined from source code alone |
| Who can modify the SSM parameter? | Any IAM principal with `ssm:PutParameter` on the resource ARN |
| Is the parameter change auditable? | Yes — SSM parameter changes generate CloudTrail events |
| Impact if set to wildcard in production | Complete bypass of domain restriction; anyone with any email domain can register |

**Recommendation:** Add a runtime safety check that rejects the wildcard value in non-development environments, or at minimum log a Critical-level warning when wildcard is active.

**Timing-Based Account Enumeration:**

The two-stage validation creates measurable timing differences:

| Scenario | Timing Profile | Operations |
|----------|---------------|------------|
| Domain rejected | ~1 SSM call | Fast rejection after domain check |
| Domain accepted, whitelist rejected | ~2 SSM calls + 1 DynamoDB call | Slower rejection (whitelist lookup) |
| Domain accepted, whitelist accepted | ~2 SSM calls + 1 DynamoDB call | Same as rejected (indistinguishable) |
| Domain accepted, public mode | ~2 SSM calls (no DynamoDB) | Medium speed |

An attacker can distinguish between "domain not allowed" (fast response) and "domain allowed but email not whitelisted" (slow response). In whitelist mode, this reveals whether a specific domain is in the allowlist without needing a valid whitelisted email.

However, this is a **low-severity** issue because:
1. The allowed domains are likely institutional (university, law school) and may already be public knowledge
2. The timing difference requires multiple measurements to confirm statistically
3. Cognito's own processing adds non-deterministic latency that masks the difference

**Error Message Information Leakage:**

The current error messages reveal which validation stage failed:

| Error Message | Information Leaked |
|---|---|
| `"Signup not allowed for email domain: ${emailDomain}"` | Confirms the domain is not in the allowlist; reveals the extracted domain value |
| `"Signup not allowed: your email (${email}) is not on the access list."` | Confirms the domain IS allowed but the specific email is not whitelisted |

This allows an attacker to:
1. Enumerate which domains are in the allowlist by testing different domains
2. Confirm when they have a valid domain, then attempt to guess whitelisted emails

The distinction between "domain rejected" and "whitelist rejected" messages provides a clear oracle for domain enumeration.

**Internal Error Masking:**

Non-`UserError` exceptions are correctly masked with a generic message:
```javascript
throw new Error("An error occurred during signup. Please try again later or contact an administrator.");
```

This prevents leakage of internal details (SSM parameter names, DynamoDB table names, stack traces) to the user. The original error is logged via Powertools for operational debugging.

#### Post-Confirmation Trigger Flow

**User Provisioning Logic:**

The post-confirmation trigger creates or updates a user record in PostgreSQL after Cognito confirms the user's email. Key behaviors:

1. **Upsert by email OR idp_id:** The existence check queries `WHERE idp_id = ${idpId} OR user_email = ${email}`. This handles re-confirmation scenarios (e.g., user deleted from Cognito and re-registered with same email) by updating the existing database record rather than creating duplicates.

2. **Update path (existing user):** Only updates `first_name`, `last_name`, `last_sign_in`, and `idp_id`. Does NOT modify `roles` — preserving any role assignments made by admins since the original registration. This is correct behavior.

3. **Insert path (new user):** Creates a new record with the determined role in a `user_role[]` array. Uses PostgreSQL's `ARRAY[${defaultRole}]::user_role[]` cast, which relies on the `user_role` enum type existing in the database.

4. **AdminGetUser API call:** The trigger calls Cognito's `AdminGetUser` to retrieve fresh user attributes rather than relying on the event payload. This ensures attributes are authoritative but adds ~50–100ms latency and a dependency on Cognito API availability.

**SQL Injection Prevention:**

All database queries use the `postgres` library's tagged template literals (e.g., `` sqlConnection`SELECT * FROM "users" WHERE idp_id = ${idpId}` ``), which provide automatic parameterization. No SQL injection risk exists in the current implementation.

#### First-User-Gets-Admin Race Condition

The first-user detection logic:

```javascript
const userCount = await sqlConnection`SELECT COUNT(*) as count FROM "users";`;
const isFirstUser = parseInt(userCount[0].count, 10) === 0;
```

**Race Condition Analysis:**

| Timeline | User A | User B | Outcome |
|----------|--------|--------|---------|
| T+0ms | `SELECT COUNT(*) → 0` | — | User A sees empty database |
| T+5ms | — | `SELECT COUNT(*) → 0` | User B also sees empty database |
| T+10ms | `INSERT ... roles = {admin}` | — | User A gets admin |
| T+15ms | — | `INSERT ... roles = {admin}` | **User B ALSO gets admin** |

**The race condition is CONFIRMED:**

1. **No transaction isolation:** The `SELECT COUNT(*)` and subsequent `INSERT` are separate statements with no transaction boundary. There is no `BEGIN`/`COMMIT` wrapping the sequence.
2. **No advisory lock:** No `pg_advisory_lock()` or equivalent is used to serialize the first-user check.
3. **No unique constraint on role:** The `roles` column is an array — multiple users can hold the `admin` role without constraint violation.
4. **Check-then-act anti-pattern:** The code reads a value (count), makes a decision (is it zero?), then acts (insert with admin role) — a textbook TOCTOU (time-of-check-to-time-of-use) vulnerability.

**Exploitation difficulty:** Low in theory but **timing-dependent in practice**. The window is narrow (~10–50ms between the COUNT query and the INSERT). However:
- During initial deployment, if multiple users sign up simultaneously (e.g., batch invitation emails sent), the race is plausible.
- A deliberate attacker who knows the platform is being deployed fresh could script rapid simultaneous signups.

**Impact:** Two (or more) users receive the `admin` role. Since admin can manage users, AI configuration, and access all data, an unauthorized admin represents a **Critical** privilege escalation.

**Practical Mitigation in Production:** Most deployments likely have a single administrator performing initial setup. The risk is highest during automated deployment testing or if the platform allows self-signup before manual admin seeding.

#### Database Connection Failure Handling

**Failure Mode Analysis:**

The post-confirmation trigger has a critical design choice: **it returns success even when the database write fails**.

```javascript
} catch (err) {
    logger.error("Error in post-confirmation trigger", err);
    // Database or internal errors:
    // We return the event so the user is confirmed in Cognito, but we've logged the failure.
    return event;  // ← SUCCESS response despite failure
}
```

**Downstream Impact Chain:**

| State | Cognito | Database | User Experience |
|-------|---------|----------|-----------------|
| Normal | User exists, confirmed | User record with roles | Login succeeds, authorization works |
| After DB failure | User exists, confirmed | **No user record** | Login succeeds (JWT valid), but **authorizer throws "User not found"** on every API request |
| After DB connection failure | User exists, confirmed | **No user record** | Same as above — user authenticated but completely unauthorized |

The user experiences:
1. Successful signup and email verification (Cognito side completes normally)
2. Ability to obtain valid JWT tokens via Amplify SDK
3. **Every API call fails** with 401/403 because the Lambda authorizers query `SELECT ... WHERE idp_id = ${sub}` and find no record
4. No self-service recovery path — the user cannot trigger re-provisioning

**Error scenarios that trigger this behavior:**
- RDS Proxy unreachable (VPC/security group misconfiguration, proxy in failing state)
- Database credentials rotated but Secrets Manager not updated
- Connection timeout (10-second `connect_timeout` exceeded during cold start)
- PostgreSQL at max connections (though RDS Proxy mitigates this)
- Lambda function timeout (29-second limit reached during slow DB operations)

**Retry/DLQ Mechanism:**

There is **no retry mechanism** and **no dead-letter queue** configured for this trigger. The CDK construct does not set:
- `retryAttempts` on the Lambda function
- `onFailure` destination
- EventBridge rule to capture failed invocations
- SQS dead-letter queue for later processing

The failure is logged by Powertools logger (visible in CloudWatch) but requires manual detection and intervention.

**Design Rationale (per code comment):**
> "The frontend handles the profile-missing case when the user tries to log in."

This suggests the frontend has a fallback path for users who exist in Cognito but not in the database. However, this shifts the user provisioning problem to the login flow rather than solving it at registration time.

#### Cognito-to-Database Synchronization

**Source of Truth Model:**

The platform uses a **split-authority model** where Cognito and the database each own different concerns:

| Concern | Source of Truth | Sync Mechanism |
|---------|----------------|----------------|
| User existence/authentication | Cognito User Pool | Cognito manages sign-up, verification, password reset |
| User roles/authorization | PostgreSQL `users.roles` | Post-Confirmation trigger provisions; admin UI manages |
| User metadata (name) | PostgreSQL (overwritten on each confirmation) | Post-Confirmation trigger updates from Cognito attributes |
| Email address | Both (Cognito canonical, database stored) | Post-Confirmation trigger copies from Cognito |

**Orphaned Record Scenarios:**

| Scenario | Cognito State | Database State | Impact | Recovery |
|----------|---------------|----------------|--------|----------|
| DB write failure during signup | User exists, confirmed | No record | User authenticated but unauthorized (all API calls fail) | Manual DB INSERT or admin re-triggers provisioning |
| User deleted from Cognito (admin action) | No user | Record persists with roles | Stale data; no functional impact (user can't get tokens) | Manual DB cleanup (no automated reconciliation) |
| User deleted from database (admin action) | User exists, can authenticate | No record | JWT valid but authorizer returns "User not found" | Re-run post-confirmation logic or manual INSERT |
| User email changed in Cognito | New email | Old email in `user_email` | Mismatch between Cognito identity and DB record | No sync mechanism; next sign-in doesn't trigger post-confirmation |
| User re-registers with same email after Cognito deletion | New user in Cognito (new `sub`) | Old record with old `idp_id` | Upsert updates `idp_id` to new value ✅ | Handled by existing upsert logic |

**Reconciliation Mechanism:**

There is **no automated reconciliation** between Cognito and the database. The platform relies on:
1. The post-confirmation trigger for initial provisioning
2. Admin manual intervention for edge cases
3. No periodic sync job, no Cognito event stream consumer, no consistency check

**Key Gap:** If a user's email is changed in Cognito (via `AdminUpdateUserAttributes`), the database record is never updated because no Cognito trigger fires for attribute changes (only Pre-Signup and Post-Confirmation are attached). This creates a persistent email mismatch.

### Findings

| ID | Finding | Severity | Effort | Status |
|----|---------|----------|--------|--------|
| AUTH-CT-01 | First-user-gets-admin race condition: concurrent signups can both see `COUNT(*) = 0` and both receive admin role. No transaction, lock, or unique constraint prevents dual admin assignment. | **High** | Medium | New |
| AUTH-CT-02 | Post-confirmation trigger returns success on database failure, creating users confirmed in Cognito but not provisioned in the database. These users can authenticate but fail all authorization checks with no self-service recovery path. No retry or DLQ mechanism exists. | **High** | Medium | New |
| AUTH-CT-03 | No Cognito-to-database reconciliation mechanism. Users deleted from Cognito leave orphaned database records; users deleted from the database but present in Cognito become authenticated-but-unauthorized. Email changes in Cognito are never synced to the database. | **Medium** | High | New |
| AUTH-CT-04 | Pre-Signup error messages reveal which validation stage failed: domain-rejected vs whitelist-rejected responses enable domain allowlist enumeration and confirmation that a specific domain is permitted. | **Medium** | Low | New |
| AUTH-CT-05 | Wildcard domain (`*`) support in the SSM allowlist bypasses all domain-based registration restrictions. No runtime guard prevents wildcard from being active in production. | **Medium** | Low | New |
| AUTH-CT-06 | SignupMode SSM parameter defaults to `"public"` if reading fails (`getSignupMode()` catch returns `"public"`). A transient SSM failure in whitelist-mode deployments silently degrades to unrestricted public signup for any allowed-domain email. | **Medium** | Low | New |

### Recommendations

**Priority 1 — Fix First-User-Gets-Admin Race (AUTH-CT-01):**

Replace the check-then-act pattern with a transactional approach:

```javascript
// Option A: Advisory lock (PostgreSQL)
await sqlConnection`SELECT pg_advisory_lock(1)`;
try {
  const userCount = await sqlConnection`SELECT COUNT(*) as count FROM "users"`;
  const isFirstUser = parseInt(userCount[0].count, 10) === 0;
  const defaultRole = isFirstUser ? "admin" : "student";
  await sqlConnection`INSERT INTO "users" ... VALUES (...)`;
} finally {
  await sqlConnection`SELECT pg_advisory_unlock(1)`;
}

// Option B: Seed admin during deployment (preferred)
// Add a database migration that inserts a seeded admin account
// Remove the first-user-gets-admin logic entirely
```

**Preferred approach:** Seed the admin account during CDK deployment (via the `db_setup` migration Lambda) rather than relying on runtime first-user detection. This eliminates the race entirely and makes the admin assignment explicit and auditable.

**Priority 2 — Add Retry/DLQ for Post-Confirmation Failures (AUTH-CT-02):**

```typescript
// In CDK stack — add DLQ and retry
const provisioningDLQ = new sqs.Queue(this, "PostConfirmationDLQ", {
  retentionPeriod: Duration.days(14),
});

const postConfirmationLambda = new lambda.Function(this, "PostConfirmationLambda", {
  // ... existing config ...
  retryAttempts: 2,
  onFailure: new lambdaDestinations.SqsDestination(provisioningDLQ),
});
```

Additionally, implement a reconciliation endpoint or scheduled job that:
1. Lists Cognito users (via `ListUsers` API)
2. Compares against database `users` table by `idp_id`
3. Provisions any missing database records

**Important:** Change the trigger to throw on database failure (instead of returning `event`) so that Cognito receives the error. This causes Cognito to NOT confirm the user, which prevents the split-state problem. The user will need to retry verification.

```javascript
// Instead of silently returning event on failure:
} catch (err) {
  logger.error("Error in post-confirmation trigger", err);
  throw err; // Let Cognito know provisioning failed — user won't be confirmed
}
```

**Priority 3 — Unify Error Messages in Pre-Signup (AUTH-CT-04):**

Return a single generic message for all validation failures:

```javascript
// Replace domain-specific and whitelist-specific messages with:
throw new UserError("Signup is not available for this email address. Please contact an administrator.");
```

This eliminates the oracle that distinguishes domain rejection from whitelist rejection.

**Priority 4 — Guard Against Wildcard in Production (AUTH-CT-05):**

```javascript
// After parsing allowed domains:
if (allowedDomains.includes("*")) {
  const environment = process.env.ENVIRONMENT || "production";
  if (environment === "production") {
    logger.error("CRITICAL: Wildcard domain allowlist detected in production!");
    // Option: reject all signups, or remove wildcard from parsed list
    throw new Error("Wildcard domain configuration not permitted in production");
  }
  logger.warn("Wildcard domain allowlist active — all domains permitted");
}
```

**Priority 5 — Fail-Closed on SSM Read Failure (AUTH-CT-06):**

```javascript
async function getSignupMode() {
  if (!SIGNUP_MODE_PARAM) return "public";
  try {
    const result = await ssmClient.send(new GetParameterCommand({ Name: SIGNUP_MODE_PARAM }));
    return result?.Parameter?.Value || "public";
  } catch (err) {
    logger.error("Failed to read SignupMode SSM param — failing closed", { err });
    // In whitelist-configured deployments, fail closed (block signup) rather than open
    throw new Error("Cannot determine signup mode. Signup blocked for safety.");
  }
}
```

**Priority 6 — Implement Cognito-Database Reconciliation (AUTH-CT-03):**

This is a larger architectural improvement:
1. Add an EventBridge rule on Cognito User Pool events (or CloudTrail) to capture user deletion/modification events
2. Implement a reconciliation Lambda that runs on a schedule (e.g., daily) comparing Cognito users with database records
3. Add an admin API endpoint to manually trigger reconciliation for a specific user
4. Consider attaching a Post-Authentication trigger that verifies database record existence on each login (self-healing for provisioning failures)

---

## 8. Identity Pool Assessment

### Current Implementation

The platform deploys a Cognito Identity Pool (`CfnIdentityPool`) that federates authenticated Cognito User Pool users to temporary AWS credentials via STS `AssumeRoleWithWebIdentity`.

**Configuration summary (lines 323–336 of `api-stack.ts`):**

| Setting | Value |
|---------|-------|
| Unauthenticated identities | **Disabled** (`allowUnauthenticatedIdentities: false`) |
| Federated identity provider | Cognito User Pool (client ID + provider name) |
| Authenticated IAM role | Single role for all authenticated users |
| Role-mapping rules | **None** — no token-based or rules-based mapping |
| Unauthenticated IAM role | Not configured |

**Authenticated role trust policy (lines 577–591):**
```typescript
assumedBy: new iam.FederatedPrincipal(
  "cognito-identity.amazonaws.com",
  {
    StringEquals: {
      "cognito-identity.amazonaws.com:aud": this.identityPool.ref,
    },
    "ForAnyValue:StringLike": {
      "cognito-identity.amazonaws.com:amr": "authenticated",
    },
  },
  "sts:AssumeRoleWithWebIdentity",
)
```

**Authenticated role permissions (lines 593–607):**
```typescript
createPolicyStatement(
  ["execute-api:Invoke"],
  [
    `arn:aws:execute-api:${region}:${account}:${apiId}/*/*/admin/*`,
    `arn:aws:execute-api:${region}:${account}:${apiId}/*/*/instructor/*`,
    `arn:aws:execute-api:${region}:${account}:${apiId}/*/*/student/*`,
  ],
)
```

**Identity Pool role attachment (lines 742–749):**
```typescript
new cognito.CfnIdentityPoolRoleAttachment(this, `${id}-IdentityPoolRoles`, {
  identityPoolId: this.identityPool.ref,
  roles: {
    authenticated: authenticatedRole.roleArn,
  },
  // No role mappings - all authenticated users get the same role
});
```

The frontend Amplify configuration (`frontend/src/App.tsx`, line 44) references `VITE_IDENTITY_POOL_ID`, configuring Amplify to obtain Identity Pool credentials. However, all S3 file uploads (audio transcription files, whitelist CSVs) use **server-generated presigned URLs** rather than browser-side AWS SDK calls with Identity Pool credentials.

**Source Files:**
- `cdk/lib/api-stack.ts` — CfnIdentityPool (lines 323–336), authenticatedRole (lines 577–607), CfnIdentityPoolRoleAttachment (lines 742–749)
- `frontend/src/App.tsx` — Amplify configuration with `identityPoolId` (line 44)
- `frontend/src/pages/Case/CaseTranscriptions.tsx` — Presigned URL upload pattern (line 195)
- `frontend/src/pages/Admin/AdminWhitelist.tsx` — Presigned URL upload pattern (line 169)

### Analysis

#### Authenticated IAM Role Permissions

The single authenticated IAM role grants `execute-api:Invoke` on three resource ARN patterns:

```
arn:aws:execute-api:{region}:{account}:{apiId}/*/*/admin/*
arn:aws:execute-api:{region}:{account}:{apiId}/*/*/instructor/*
arn:aws:execute-api:{region}:{account}:{apiId}/*/*/student/*
```

The `/*/*` wildcard covers all HTTP methods and all stages. This means any authenticated user — regardless of their database role (student, instructor, or admin) — receives IAM-level permission to invoke **all** API Gateway endpoints across all role paths. The actual role enforcement is delegated entirely to Lambda authorizers.

**Least-privilege violation:** A student user's temporary AWS credentials can call `POST /admin/users` at the IAM layer. While the Lambda authorizer will reject the request at the application layer, the IAM policy does not enforce role boundaries. This represents a violation of the principle of least-privilege — the IAM layer should restrict access to only the role-appropriate paths.

**Practical impact:** In the current architecture, this is a **low-severity** issue because Lambda authorizers consistently enforce role checks before processing requests. However, if a Lambda authorizer were misconfigured, disabled, or bypassed (e.g., through an API Gateway misconfiguration where a route lacks a security scheme), the IAM layer would provide no backstop.

#### Absence of Role-Mapping Rules

The `CfnIdentityPoolRoleAttachment` explicitly uses **no role-mapping rules** — all authenticated users receive the identical IAM role. Cognito Identity Pool supports two mapping strategies that are not utilized:

1. **Token-based mapping** — Map the Cognito `cognito:groups` claim or a custom attribute to different IAM roles (e.g., students get a restricted role, admins get a broader role)
2. **Rules-based mapping** — Define rules that match token claims to specific IAM roles

**Defense-in-depth gap:** The absence of role-mapping creates a single-layer authorization architecture at the IAM level:

| Scenario | Current Behavior | With Role Mapping |
|----------|-----------------|-------------------|
| Compromised Lambda authorizer | Student credentials can invoke admin endpoints (IAM allows it) | Student credentials are IAM-restricted to `/student/*` only |
| Missing `security` declaration on an API route | Any authenticated user can access the route | IAM-level enforcement prevents cross-role access |
| API Gateway misconfiguration | Broad access | IAM provides secondary enforcement |

**Recommendation:** Implementing token-based role mapping using `cognito:groups` (which would require adding users to Cognito groups during provisioning) would provide a second authorization layer independent of the Lambda authorizers. However, this adds operational complexity — role changes would require both database updates AND Cognito group membership changes.

#### Temporary Credential Scope

**STS session duration:** The Identity Pool uses the default STS session duration for web identity federation, which is **1 hour** (3,600 seconds). No custom `DurationSeconds` is configured. This means temporary credentials remain valid for up to 1 hour even if the user logs out of the application (tokens are separate from STS credentials).

**Beyond-API-Gateway access:** The authenticated role's inline policy contains **only** `execute-api:Invoke` permissions. The credentials cannot be used to access S3, DynamoDB, Lambda, or any other AWS service directly. This is correctly scoped.

**Frontend direct AWS service usage:** Despite the Identity Pool being configured in the Amplify SDK, the frontend does **not** use the temporary credentials for direct AWS service access:
- Audio file uploads use presigned URLs generated by a backend Lambda (`generatePreSignedURL` Python function)
- Whitelist CSV uploads use presigned URLs generated by the admin handler
- No `@aws-amplify/storage`, `S3Client`, or `DynamoDBClient` imports exist in the frontend codebase

The Identity Pool credentials appear to be used solely by Amplify's internal authentication flow for signing API Gateway requests (Signature V4), though the API Gateway uses Lambda token authorizers (not IAM authorization), making this redundant.

#### Identity Pool Necessity

**Assessment: The Identity Pool appears to be unnecessary for the current architecture.**

Evidence supporting removal:

| Factor | Analysis |
|--------|----------|
| API Gateway auth type | Lambda token authorizers (custom auth), NOT IAM authorization — Identity Pool credentials are not required to invoke the API |
| Frontend S3 access | Uses server-generated presigned URLs, not browser-side AWS SDK with Identity Pool credentials |
| Frontend DynamoDB access | None — all data access goes through REST API |
| Amplify SDK configuration | References `identityPoolId` but the SDK's `fetchAuthSession()` is used only for the `idToken`, not AWS credentials |
| WebSocket authentication | Token-based (Authorization header / Sec-WebSocket-Protocol), not SigV4-signed with Identity Pool credentials |

**Dependent features analysis:**
- The `amplify-stack.ts` CSP includes `cognito-identity.amazonaws.com` in `connect-src`, suggesting the browser contacts the Identity Pool endpoint — but this may be an artifact of configuring `identityPoolId` in Amplify rather than an actual functional dependency
- No frontend code calls `fetchAuthSession().credentials` or passes credentials to AWS SDK clients

**If the Identity Pool were removed:**
- The `VITE_IDENTITY_POOL_ID` environment variable and Amplify `identityPoolId` config would be removed
- The `authenticatedRole` IAM role and its policy would be removed
- The `CfnIdentityPoolRoleAttachment` would be removed
- API Gateway access would continue to work via the `Authorization` header with Lambda token authorizers
- All S3 operations would continue via presigned URLs
- Attack surface would be reduced: no STS credential issuance, no IAM role for browser use

**Risk of keeping:** The Identity Pool issues STS credentials to every authenticated user's browser. If an XSS attack exfiltrates these credentials (which are accessible to JavaScript, unlike httpOnly cookies), an attacker gains 1-hour AWS credentials with `execute-api:Invoke` permissions across all role paths. While this is functionally equivalent to stealing the Cognito ID token, the STS credentials cannot be revoked before expiration (unlike tokens which can be invalidated via GlobalSignOut).

### Findings

| ID | Finding | Severity | Effort | Status |
|----|---------|----------|--------|--------|
| AUTH-IP-01 | **Overly broad IAM policy on authenticated role** — All authenticated users receive `execute-api:Invoke` on admin/*, instructor/*, and student/* paths regardless of their actual role. IAM layer provides no role-boundary enforcement. | Medium | Medium | New |
| AUTH-IP-02 | **No role-mapping rules configured** — All authenticated users receive the same IAM role without token-based or rules-based differentiation. A compromised authorizer or misconfigured route has no IAM backstop. | Medium | High | New |
| AUTH-IP-03 | **Identity Pool appears unnecessary** — The current architecture does not require Identity Pool credentials for any frontend functionality. API access uses Lambda token authorizers; S3 access uses presigned URLs. The Identity Pool increases attack surface by issuing STS credentials to browsers without functional benefit. | Medium | Medium | New |
| AUTH-IP-04 | **STS credentials irrevocable for 1-hour window** — Identity Pool issues 1-hour STS credentials that cannot be revoked via Cognito GlobalSignOut. An XSS-exfiltrated credential remains valid until expiration regardless of session invalidation actions. | Low | Low | New |
| AUTH-IP-05 | **Wildcard stage and method in resource ARNs** — The `/*/*` pattern in resource ARNs (`/*/*/admin/*`) grants invoke permissions across all stages (prod, dev, etc.) and all HTTP methods, exceeding minimum necessary access. | Low | Low | New |

### Recommendations

**1. Evaluate Identity Pool removal (AUTH-IP-03) — Recommended first action**

Conduct a controlled test by removing the `identityPoolId` from the Amplify configuration and verifying all frontend flows continue to work:

```typescript
// frontend/src/App.tsx — Remove identityPoolId from Amplify config
const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
      // identityPoolId: REMOVED
      loginWith: { email: true },
      signUpVerificationMethod: "code" as const,
      allowGuestAccess: false,
    },
  },
};
```

If all flows pass (API calls, file uploads, WebSocket), proceed to remove the CDK resources:
- `CfnIdentityPool`
- `CfnIdentityPoolRoleAttachment`
- `authenticatedRole` and `AuthenticatedPolicy`
- `VITE_IDENTITY_POOL_ID` from Secrets Manager

**2. If Identity Pool is retained — Implement role-based mapping (AUTH-IP-01, AUTH-IP-02)**

Add Cognito groups and token-based role mapping:

```typescript
// Add role mapping to CfnIdentityPoolRoleAttachment
new cognito.CfnIdentityPoolRoleAttachment(this, `${id}-IdentityPoolRoles`, {
  identityPoolId: this.identityPool.ref,
  roles: {
    authenticated: studentRole.roleArn, // Default to least-privileged role
  },
  roleMappings: {
    cognitoProvider: {
      identityProvider: `${this.userPool.userPoolProviderName}:${this.appClient.userPoolClientId}`,
      type: "Token",
      ambiguousRoleResolution: "Deny",
    },
  },
});
```

This requires adding users to Cognito groups (`admin`, `instructor`, `student`) during the post-confirmation trigger and maintaining group membership in sync with database role changes.

**3. Restrict resource ARN scope (AUTH-IP-05)**

If the Identity Pool is retained, narrow the resource ARNs:

```typescript
// Replace /*/*/ with specific stage and methods
[
  `arn:aws:execute-api:${region}:${account}:${apiId}/prod/*/student/*`,
]
```

**4. Reduce STS session duration (AUTH-IP-04)**

If the Identity Pool is retained, configure a shorter session duration via the authenticated role's session policy or by setting `DurationSeconds` on the Identity Pool (note: Cognito Identity Pool does not directly expose this — it uses the 1-hour default for enhanced auth flow). Consider switching to the basic auth flow if shorter sessions are required.

**Priority order:** AUTH-IP-03 (remove entirely) > AUTH-IP-01/02 (role mapping if kept) > AUTH-IP-05 (ARN narrowing) > AUTH-IP-04 (session duration)

---

## 9. Frontend Session Management Assessment

### Current Implementation

**Source Files:**
- `frontend/src/pages/Login.tsx` — Authentication page (sign-in, sign-up, password reset, confirmation flows)
- `frontend/src/App.tsx` — Amplify SDK v6 configuration, auth state management, route protection
- `frontend/src/contexts/UserContext.tsx` — User identity context provider
- `frontend/src/contexts/NotificationContext.tsx` — WebSocket connection management
- `frontend/src/hooks/useWebSocket.ts` — WebSocket hook with token rotation
- `frontend/src/services/notificationService.ts` — API service with auth token retrieval
- `frontend/src/components/AdvocateHeader.tsx`, `SupervisorHeader.tsx`, `AdminHeader.tsx` — Sign-out handlers
- `cdk/lib/amplify-stack.ts` — CSP headers and security header configuration

**Amplify SDK v6 Integration:**

The frontend uses AWS Amplify SDK v6 (`aws-amplify/auth`) with the following configuration:

```typescript
// App.tsx - Amplify configuration
const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
      identityPoolId: import.meta.env.VITE_IDENTITY_POOL_ID,
      loginWith: { email: true },
      signUpVerificationMethod: "code",
      allowGuestAccess: false,
    },
  },
};

Amplify.configure(amplifyConfig);
cognitoUserPoolsTokenProvider.setKeyValueStorage(amplifySessionStorage);
```

**Key architectural decisions:**
1. **Auth flow:** Uses `signIn({ username: email, password })` — this defaults to SRP (Secure Remote Password) in Amplify SDK v6 unless explicitly overridden. The password is never transmitted in plaintext.
2. **Token obtainment:** After `signIn()`, tokens are retrieved via `fetchAuthSession()` which returns `session.tokens?.idToken` and `session.tokens?.accessToken`.
3. **Automatic refresh:** Amplify SDK v6 automatically refreshes expired access/ID tokens using the stored refresh token when `fetchAuthSession()` is called.
4. **Session persistence:** Explicitly configured to use **browser `sessionStorage`** via `cognitoUserPoolsTokenProvider.setKeyValueStorage(amplifySessionStorage)`. This is a security-conscious choice — tokens are cleared when the browser tab/window is closed.

**Authentication Flow in Login.tsx:**
- Sign-in: `signIn({ username, password })` → `window.location.reload()` on success
- Sign-up: `signUp({ username, password, options: { userAttributes } })` → email confirmation code → `confirmSignUp()` → auto-login
- Password reset: `resetPassword({ username })` → `confirmResetPassword({ username, confirmationCode, newPassword })`

**Token Usage Pattern:**
All API calls use bearer token authentication via the ID token:
```typescript
const session = await fetchAuthSession();
const token = session.tokens?.idToken?.toString();
// Used as: headers: { Authorization: token }
```

### Analysis

#### Token Storage Mechanism

**Storage API:** `sessionStorage` (browser-native Web Storage API)

**Positive findings:**
- The explicit `cognitoUserPoolsTokenProvider.setKeyValueStorage(amplifySessionStorage)` call configures Amplify to use `sessionStorage` rather than the default `localStorage`. This is the more secure option:
  - Tokens are automatically cleared when the browser tab/window is closed
  - Tokens are not shared across browser tabs (tab-isolation)
  - Reduces the window of token theft from persistent storage

**Security concerns:**
- `sessionStorage` is accessible to any JavaScript running in the same origin. An XSS attack can read all stored tokens (access token, ID token, refresh token) via `window.sessionStorage`.
- There is **no httpOnly cookie alternative** — Amplify SDK v6 does not support httpOnly cookie-based token storage. The tokens are inherently accessible to client-side JavaScript.
- Migration to httpOnly cookies would require a backend-for-frontend (BFF) proxy pattern to issue and validate cookies, which represents a significant architectural change.

**CSP Configuration:**
The platform deploys a Content-Security-Policy header via both Amplify Hosting custom headers and Vite dev server:
```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
img-src 'self' data: https:;
font-src 'self' data: https://fonts.gstatic.com;
connect-src 'self' wss: https:; [or locked-down endpoints when DomainName configured]
frame-ancestors 'none';
```

**CSP weaknesses:**
- `script-src 'unsafe-inline' 'unsafe-eval'` — Significantly weakens XSS protection. `unsafe-inline` allows inline `<script>` tags and event handlers; `unsafe-eval` allows `eval()`, `Function()`, and similar. An attacker who achieves HTML injection can execute arbitrary scripts despite the CSP.
- When `DomainName` is NOT configured in CDK deployment, `connect-src` uses the permissive `'self' wss: https:` which allows connections to any HTTPS/WSS endpoint.
- When `DomainName` IS configured, `connect-src` is locked to specific API, WebSocket, and Cognito endpoints — this is the secure production configuration.

#### XSS Exposure

**dangerouslySetInnerHTML usage:**
One instance found in `CaseTranscriptions.tsx`:
```typescript
dangerouslySetInnerHTML={{
  __html: DOMPurify.sanitize(marked.parse(selectedTranscription.audio_text || ""))
}}
```
This is properly sanitized through DOMPurify before rendering. The pipeline is: raw text → `marked.parse()` (markdown to HTML) → `DOMPurify.sanitize()` (strip dangerous elements) → render.

**User content sanitization:**
- **AI responses** (`AIResponse.tsx`): Uses `ReactMarkdown` with `rehypeSanitize` plugin — properly sanitized
- **Case summaries** (`CaseSummaries.tsx`): Uses `ReactMarkdown` with `rehypeSanitize` plugin — properly sanitized
- **Notepad** (`Notepad.tsx`): Uses `DOMPurify.sanitize()` on both input (initialContent) and output (before save) — properly sanitized
- **Transcriptions** (`CaseTranscriptions.tsx`): Uses `DOMPurify.sanitize(marked.parse(...))` — properly sanitized

**Assessment:** The application demonstrates consistent sanitization practices across all user-generated content rendering paths. However, the weak CSP (`unsafe-inline`, `unsafe-eval`) means that if any injection point is missed (e.g., in a future component), the CSP provides no fallback defense.

**Token extraction via XSS:**
If an XSS vulnerability is exploited, an attacker can:
1. Read all Cognito tokens from `sessionStorage`
2. Call `fetchAuthSession()` to get fresh tokens
3. Exfiltrate tokens to an external endpoint (CSP `connect-src` may limit this in production, but `unsafe-eval` allows workarounds)

#### CSRF Protections

**Bearer token architecture:**
- All API calls use `Authorization: <idToken>` header-based authentication
- Bearer tokens are NOT automatically attached by the browser (unlike cookies) — this provides **inherent CSRF resistance**
- A cross-origin attacker cannot forge requests that include the `Authorization` header because:
  - They cannot read `sessionStorage` from a different origin
  - CORS preflight would block the custom `Authorization` header

**Cookie-based auth risk:**
- The platform does NOT use cookie-based authentication for API calls
- Cognito may set cookies for its hosted UI, but the application uses the Amplify SDK direct flow, not the hosted UI
- **No CSRF vulnerability exists** in the current bearer-token architecture

**CORS configuration:**
- API Gateway uses the `CorsAllowedOrigin` parameter (via OpenAPI `Fn::Sub`) to set `Access-Control-Allow-Origin`
- When `DomainName` is configured: locked to the specific domain origin
- When `DomainName` is NOT configured: defaults to `*` (wildcard) — any origin can make API calls if they have a valid token
- Lambda handlers use the `ALLOWED_ORIGIN` environment variable; if unset, they fall back to `*` with a warning logged (per REMEDIATION-STATUS.md fix S-M4)
- **Risk:** In development or misconfigured deployments, the wildcard CORS allows any website to make credentialed API calls if the attacker already has a token. Combined with XSS (which could steal tokens), this amplifies the impact.

#### Session Termination Behavior

**Browser close behavior:**
- Tokens stored in `sessionStorage` are automatically cleared when the browser tab/window is closed
- This effectively terminates the session on tab close — **good security posture**
- However, the Cognito refresh token remains valid server-side until its TTL expires; only the browser copy is destroyed

**Token expiry handling:**
- Amplify SDK v6 automatically refreshes tokens when `fetchAuthSession()` is called and the access/ID token is expired
- The `useWebSocket.ts` hook implements proactive token rotation: it parses the JWT `exp` claim and schedules a WebSocket reconnection 30 seconds before token expiry
- If token refresh fails (e.g., refresh token expired), the user will see API 401 errors; however, there is **no explicit UI handling** to redirect to login on token refresh failure

**Idle timeout:**
- **No idle timeout is implemented.** The application does not track user activity or force re-authentication after a period of inactivity.
- As long as the browser tab remains open, the Amplify SDK will continuously refresh tokens (every ~30 minutes for access/ID tokens)
- A user who steps away from their workstation remains authenticated indefinitely until the browser tab is closed or the refresh token expires (Cognito default: 30 days)

**Concurrent session limits:**
- **No concurrent session detection or limiting is implemented.** A user can be authenticated in multiple browser tabs/windows and on multiple devices simultaneously.
- Cognito does not natively limit concurrent sessions unless a custom Lambda trigger is used to track and revoke sessions.

**Logout implementation:**
- All role-specific headers (`AdvocateHeader.tsx`, `SupervisorHeader.tsx`, `AdminHeader.tsx`) call `signOut()` from `aws-amplify/auth`
- The Amplify `signOut()` function:
  - Clears all tokens from `sessionStorage`
  - Calls Cognito's token revocation endpoint to invalidate the refresh token
  - Does NOT call `GlobalSignOut` (which would invalidate ALL sessions across all devices)
- After `signOut()`, the page redirects to `/` or reloads, triggering re-evaluation of auth state
- **Gap:** The `signOut()` call does not invalidate the access/ID tokens — they remain valid until expiration (30 minutes). An attacker who captured these tokens retains access for up to 30 minutes post-logout.

#### Login Page Security

**HTTPS enforcement:**
- The Amplify Hosting configuration includes `Strict-Transport-Security: max-age=31536000; includeSubDomains` (HSTS)
- API Gateway endpoints are HTTPS-only by default
- No HTTP fallback exists — **login form is served exclusively over HTTPS** ✓

**Autocomplete attributes:**
- Email field: `autoComplete="email"` — appropriate, allows password managers
- Password field (sign-in): `autoComplete="current-password"` — correct for login forms
- Password field (sign-up): No explicit `autoComplete` attribute on the new password field; confirm password also lacks it
- New password (reset): `autoComplete` not set — should use `autoComplete="new-password"`
- **Assessment:** Autocomplete attributes are largely correct, enabling secure password manager integration

**Credential exposure in DOM/logs:**
- Password state is held in React component state (`useState`) — ephemeral and not persisted to storage
- Password field uses `type="password"` (with visibility toggle via `type={showPassword ? "text" : "password"}`)
- No `console.log()` statements in Login.tsx — **no credential logging** ✓
- Error messages use `cleanErrorMessage()` to strip Cognito Lambda trigger prefixes — reduces information disclosure
- Error display via Snackbar does not echo back the password or email in error state

**Brute-force protection:**
- Login.tsx does NOT implement client-side rate limiting, account lockout display, or progressive delays
- Brute-force protection relies entirely on **Cognito server-side controls:**
  - Cognito blocks accounts after multiple failed attempts (default: 5 attempts, then temporary lockout with exponential backoff)
  - No CAPTCHA or challenge mechanism is presented to the user after failed attempts
  - The error message on lockout (`"Password attempts exceeded"`) may allow an attacker to confirm account existence
- **Gap:** No client-side protection (CAPTCHA, progressive delays) supplements the Cognito-native rate limiting

**Additional Login.tsx security observations:**
- The sign-up confirmation code field has no length/format validation (Cognito codes are 6 digits) — minor usability issue, not a security vulnerability
- Password requirements are validated client-side with real-time feedback (12+ chars, uppercase, lowercase, digit, special) — aligns with User Pool policy
- The `window.location.reload()` after successful sign-in ensures fresh auth state evaluation — avoids stale credential caching

### Findings

| ID | Finding | Severity | Effort | Status |
|----|---------|----------|--------|--------|
| AUTH-FS-01 | CSP allows `unsafe-inline` and `unsafe-eval` in `script-src`, severely weakening XSS defense-in-depth for token-bearing sessions | High | High | New |
| AUTH-FS-02 | No idle/inactivity timeout — authenticated sessions persist indefinitely while browser tab remains open, relying solely on refresh token TTL (up to 30 days default) | Medium | Medium | New |
| AUTH-FS-03 | No concurrent session detection or limiting — multiple simultaneous sessions permitted across devices without visibility or control | Medium | High | New |
| AUTH-FS-04 | Logout does not invalidate access/ID tokens server-side — tokens remain valid for up to 30 minutes post-logout (only refresh token is revoked) | Medium | Medium | New |
| AUTH-FS-05 | Token refresh failure has no explicit UI handling — users encounter silent API failures rather than a clear redirect to re-authentication | Low | Low | New |
| AUTH-FS-06 | No client-side CAPTCHA or progressive delay after failed login attempts — relies entirely on Cognito server-side rate limiting | Low | Medium | New |
| AUTH-FS-07 | CORS defaults to wildcard (`*`) when `DomainName` CDK context parameter is not set, allowing any origin to interact with API if tokens are obtained | Medium | Low | Partial |
| AUTH-FS-08 | `connect-src` CSP directive is permissive (`wss: https:`) when no custom domain is configured, allowing token-bearing requests to arbitrary endpoints | Low | Low | New |

### Recommendations

1. **AUTH-FS-01 — Strengthen CSP script-src (High priority, High effort)**
   - Remove `unsafe-inline` and `unsafe-eval` from `script-src`. This requires:
     - Migrating inline styles to external CSS (or using `style-src` nonces)
     - Ensuring no runtime `eval()` usage (check third-party libraries)
     - Adding nonce-based script loading if dynamic scripts are needed
   - As an interim step, add `'strict-dynamic'` with nonce support to limit inline script execution
   - Consider deploying a `report-uri` or `report-to` directive to monitor CSP violations before enforcing strict mode

2. **AUTH-FS-02 — Implement idle timeout (Medium priority, Medium effort)**
   - Add an activity monitor (mouse move, keyboard, focus events) that tracks last user interaction
   - After a configurable inactivity period (recommended: 15–30 minutes for legal content), show a warning modal
   - If no activity after the warning period (e.g., 5 minutes), call `signOut()` and redirect to login
   - Example implementation pattern:
     ```typescript
     // In App.tsx or a dedicated IdleTimer provider
     const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
     const WARN_BEFORE_MS = 5 * 60 * 1000;  // Warn 5 min before logout
     ```

3. **AUTH-FS-03 — Consider concurrent session visibility (Medium priority, High effort)**
   - For the legal education context, concurrent sessions may be acceptable
   - At minimum, implement a "sessions" view showing active devices (using Cognito `AdminListDevices` or custom tracking)
   - If stricter control is needed, implement a custom Pre-Authentication Lambda trigger that checks active session count

4. **AUTH-FS-04 — Evaluate GlobalSignOut for logout (Medium priority, Medium effort)**
   - Replace `signOut()` with `signOut({ global: true })` to invoke Cognito `GlobalSignOut`, which invalidates all tokens including access tokens
   - Tradeoff: This also signs out other devices, which may not be desired — offer as "Sign out everywhere" option
   - Alternative: Accept the 30-minute window as acceptable given the sessionStorage isolation (tokens only accessible from the same tab)

5. **AUTH-FS-05 — Handle token refresh failure gracefully (Low priority, Low effort)**
   - Wrap `fetchAuthSession()` calls in a global error boundary or interceptor
   - On refresh failure, display a "Session expired" toast and redirect to login
   - Example: Create an `AuthErrorBoundary` component or add logic in App.tsx `checkAuthState`

6. **AUTH-FS-06 — Add CAPTCHA for sign-up and after repeated login failures (Low priority, Medium effort)**
   - Integrate AWS WAF CAPTCHA or a third-party CAPTCHA (hCaptcha, Turnstile) on the sign-up form
   - Consider showing CAPTCHA after 3 client-detected failed login attempts (using component state counter)
   - Cognito Custom Auth flow can be used to implement server-side CAPTCHA challenges

7. **AUTH-FS-07 — Ensure CORS is locked down in production (Medium priority, Low effort)**
   - Verify that all production deployments set the `DomainName` CDK context parameter
   - Consider failing closed (returning no CORS headers) rather than falling back to wildcard when `ALLOWED_ORIGIN` is unset
   - Add a deployment check/assertion that rejects stack synthesis without `DomainName` in production environments

8. **AUTH-FS-08 — Tighten CSP connect-src for non-domain deployments (Low priority, Low effort)**
   - For development/staging without a custom domain, enumerate specific backend endpoints in `connect-src` rather than allowing all `https:`/`wss:` destinations
   - Use environment-specific Vite config to inject the correct CSP based on `VITE_API_ENDPOINT`

---

## 10. Consolidated Findings from Existing Reviews

### Methodology

Findings were extracted from all 11 existing code review documents in `docs/code-reviews/` where the finding pertains to: JWT validation, Cognito configuration, Lambda authorizer behavior, role enforcement, token handling, session management, WebSocket authentication, credential storage, or identity federation.

Each finding is cross-referenced with its status in `REMEDIATION-STATUS.md` (last updated 2025-07-21). Where a finding appears in multiple source documents, it is consolidated as a single entry referencing all sources, using the highest severity classification among them. Findings unrelated to authentication/authorization (e.g., pure performance, cost optimization, code quality) are excluded.

### Source Documents

| # | Document | Auth-Related Findings | Key Auth Domains Covered |
|---|----------|----------------------|--------------------------|
| 1 | `code-review-security.md` | 8 | Authorizer mutable state, rate limit bypass, WebSocket throttling, CORS, credential exposure, session management |
| 2 | `code-review-lambda-functions.md` | 5 | Rate limit bypass, fail-open auth, stale DB connections (authorizer dependency), guardrail bypass, playground authorization |
| 3 | `code-review-nodejs-handlers.md` | 6 | Authorizer mutable response, WebSocket token exposure, user enumeration, role code duplication, connection management |
| 4 | `code-review-frontend.md` | 4 | Duplicate WebSocket auth, route-level auth guards, password in state, token storage |
| 5 | `code-review-cdk-infrastructure.md` | 4 | Cognito config, WebSocket throttling, dataTraceEnabled (token logging), monolithic auth stack |
| 6 | `code-review-networking-waf.md` | 3 | WAF per-user rate limiting, TLS validation for auth connections, authorizer availability (NAT SPOF) |
| 7 | `code-review-database.md` | 3 | SQL injection in credential creation, roles array constraint, user schema |
| 8 | `code-review-bedrock.md` | 2 | Playground authorization bypass, IAM over-permissioning (compromised auth blast radius) |
| 9 | `code-review-rds.md` | 4 | Secret rotation, VPC-wide DB access (auth DB exposure), connection timeouts (authorizer deps), credential placeholders |
| 10 | `code-review-s3-best-practices.md` | 1 | Pre-signed URL expiration (auth token scope) |
| 11 | `code-review-well-architected.md` | 3 | Secret rotation, X-Ray tracing (auth observability), Lambda provisioned concurrency (auth cold starts) |

### Consolidated Findings Table

| Original ID | Source Document(s) | Finding | Severity | Effort | REMEDIATION-STATUS | Re-Verification Needed | AUTH Section Reference |
|-------------|-------------------|---------|----------|--------|-------------------|----------------------|----------------------|
| S-C3, Node-C1 | Security, Node.js Handlers | Authorizer `responseStruct` is a shared mutable object — Statement array accumulates across warm invocations, causing memory leak and potential authorization bypass | Critical | Low | ✅ Fixed | ⚠️ Yes — partial layer fix; `buildAuthResponse()` pattern confirmed but needs verification that no authorizer reverted to old pattern | §3 Lambda Authorizers |
| S-C2, CDK-H3 | Security, CDK Infrastructure | Text generation Lambda uses admin DB credentials (`secretPathAdmin`) instead of application user — compromised Lambda gets full DDL access including user credential modification | Critical | Low | ✅ Fixed | No | §4 RBAC |
| Lambda-C3, S-H1 | Lambda Functions, Security | Race condition in rate limiting (SELECT then UPDATE without lock) allows concurrent requests to bypass daily message limit — impacts auth-adjacent abuse control | High | Medium | ✅ Fixed | No — atomic `UPDATE...RETURNING` pattern verified | §5 Token Lifecycle |
| Lambda-H1, S-H2 | Lambda Functions, Security | Rate limit fails open on exception — database outage removes all rate limiting, allowing unlimited authenticated API calls | High | Low | ✅ Fixed | No — returns 503 on failure confirmed | §5 Token Lifecycle |
| S-H3, CDK-M6 | Security, CDK Infrastructure | WebSocket API has no stage-level throttling — authenticated user can flood messages triggering unbounded Lambda invocations | High | Low | ✅ Fixed | No — stage throttle 100 rps/200 burst confirmed | §6 WebSocket Auth |
| Node-H3 | Node.js Handlers | WebSocket token passed via `Sec-WebSocket-Protocol` header — full JWT echoed in response header, visible in network logs and intermediary caches | High | Medium | ⬜ Open | N/A | §6 WebSocket Auth |
| S-M1, Lambda-M3, BDK-M4 | Security, Lambda Functions, Bedrock | Playground Lambda has no role-based authorization — relies solely on WebSocket router `isStaff` check; if Lambda invoked directly, no protection; guardrail also fails open | Medium | Low | ⬜ Open | N/A | §4 RBAC |
| S-M2, Node-M2 | Security, Node.js Handlers | User enumeration via `/student/get_name` — any authenticated user can look up any other user's first name by email, confirming registered emails | Medium | Low | ⏸ Deferred | N/A (product decision) | §4 RBAC |
| Node-M1 | Node.js Handlers | Massive code duplication across 4 authorizer functions (~200 lines each) — JWT verifier init, user metadata lookup, caching, IAM policy generation duplicated; bug fixes require 4 changes | Medium | Medium | ⬜ Open | N/A | §3 Lambda Authorizers |
| S-M4, Lambda-M4 | Security, Lambda Functions | CORS origin falls back to wildcard (`*`) silently when `ALLOWED_ORIGIN` not set — misconfigured deployment degrades cross-origin protection for auth endpoints | Medium | Low | ✅ Fixed | ⚠️ Yes — warning logged but still falls back to `*`; should consider fail-closed | §9 Frontend Session |
| S-M8, Node-M5 | Security, Node.js Handlers | Inconsistent message counter reset logic — Node.js uses 24-hour window vs Python calendar day; users can exploit gap around reset boundary to exceed rate limits | Medium | Low | ✅ Fixed | No — both aligned to UTC calendar day | §5 Token Lifecycle |
| Lambda-H3, S-M5 | Lambda Functions, Security | Stale database connections not detected in Python Lambdas — authorizer database lookups fail on first request after idle period | Medium | Medium | ⚠️ Partial | ⚠️ Yes — Node.js fixed (`SELECT 1` health check), Python `connect_to_db()` still lacks health check (Lambda-H3 Open) | §3 Lambda Authorizers |
| Lambda-M2 | Lambda Functions | SSM parameters never refreshed on warm starts — admin changes to auth-adjacent config (model ID, rate limits) require Lambda recycling | Medium | Low | ⬜ Open | N/A | §5 Token Lifecycle |
| Frontend-H1 | Frontend | Duplicate WebSocket connections per authenticated user — both NotificationContext and useWebSocket create separate connections, doubling auth invocations | Medium | Medium | ⏸ Deferred | N/A | §6 WebSocket Auth |
| Frontend-M1 | Frontend | No route-level authorization guards in React — shared case routes accessible to all authenticated users regardless of role (backend enforces, but UX gap) | Medium | Low | ⏸ Deferred | N/A | §9 Frontend Session |
| Frontend-L2 | Frontend | Password stored in component state after sign-up for auto-login — remains in React state briefly until `window.location.reload()` | Low | Low | ⬜ Open | N/A | §9 Frontend Session |
| DB-L2 | Database | No database-level constraint preventing empty `roles` array — if application-level check bypassed, user ends up with no roles causing auth failures | Low | Low | ⬜ Open | N/A | §4 RBAC |
| DB-H1, S-M6 | Database, Security | SQL injection pattern in password creation (`createAppUsers()`) — hex-only passwords currently safe but dangerous pattern if generation logic changes | Medium | Low | ✅ Fixed | ⚠️ Yes — parameterized query with `$1`, `$2` confirmed for db_setup; verify no other credential creation paths exist | §8 Identity Pool |
| RDS-C1, WA-H5 | RDS, Well-Architected | No automatic secret rotation for database credentials — compromised credential has unlimited lifetime; violates credential hygiene | High | Medium | ⬜ Open | N/A | §8 Identity Pool |
| RDS-H2 | RDS | VPC-wide security group rule allows any VPC resource to connect to auth database on port 5432 — overly permissive network access to authorization data store | High | Medium | ⬜ Open | N/A | §3 Lambda Authorizers |
| RDS-L1 | RDS | Placeholder passwords visible in CloudFormation template — `SecretValue.unsafePlainText("applicationPassword")` appears in synthesized templates | Low | Low | ⬜ Open | N/A | §8 Identity Pool |
| CDK-H2 | CDK Infrastructure | Cognito User Pool `removalPolicy: RETAIN` but comment says "Delete" — misleading comment could lead to accidental auth data loss | Medium | Low | ✅ Fixed | No | §2 Cognito User Pool |
| CDK-M2, S-H4 | CDK Infrastructure, Security | `dataTraceEnabled: true` logs full request/response bodies including auth tokens and privileged content to CloudWatch | High | Low | ⏸ Deferred | N/A (re-enabled for dev) | §5 Token Lifecycle |
| S-H6, Lambda-H4 | Security, Lambda Functions | Guardrail bypass on initial conversation turn — first message constructed from `case_description` without guardrail check; auth-adjacent since bypasses content safety for authenticated users | High | Low | ⬜ Open | N/A | §4 RBAC |
| BDK-H4 | Bedrock | Overly broad IAM permissions (`foundation-model/*`) — compromised authorizer or Lambda grants access to all Bedrock models across regions | High | Low | ✅ Fixed | No — scoped to `anthropic.*` and `meta.*` | §8 Identity Pool |
| NW-H1, CDK-H4, WA-H3 | Networking/WAF, CDK, Well-Architected | Single NAT Gateway SPOF — AZ failure causes all authorizer Lambda functions to lose Secrets Manager access, breaking authentication | High | Low | ⬜ Open | N/A | §3 Lambda Authorizers |
| S3-H2 | S3 Best Practices | Pre-signed URL for whitelist CSV has 1-hour expiration — leaked URL allows unauthorized user injection into whitelist for extended window | High | Low | ✅ Fixed | No — reduced to 300 seconds (5 minutes) | §4 RBAC |
| WA-M2 | Well-Architected | X-Ray tracing only on Python Lambdas — Node.js authorizers invisible in distributed traces, impeding auth failure diagnosis | Medium | Low | ✅ Fixed | No — `tracing: ACTIVE` added to all Node.js Lambdas | §3 Lambda Authorizers |

### Findings Requiring Re-Verification

The following findings are marked ✅ Fixed in REMEDIATION-STATUS.md but warrant re-verification based on the criteria: fix applied >90 days ago without subsequent validation, fix addresses only one enforcement layer while finding spans multiple layers, or fix depends on configuration that may differ between environments.

| Original ID | Finding | Reason for Re-Verification | Recommended Verification |
|-------------|---------|---------------------------|--------------------------|
| S-C3, Node-C1 | Authorizer `responseStruct` mutable object | Fix (`buildAuthResponse()`) confirmed in 3 REST authorizers but WebSocket authorizer (`wsAuthorizer.js`) also uses a response pattern — verify it also creates fresh objects per invocation | Inspect `wsAuthorizer.js` for module-level mutable state; verify no regression in authorizers |
| S-M4, Lambda-M4 | CORS wildcard fallback | Fix logs a warning but still falls back to `*` — a "fail-open" CORS is still present despite the warning. Multi-layer: Node.js handlers and Python Lambdas both have this pattern | Verify all Lambda response helpers return a restrictive CORS header (or no header) when `ALLOWED_ORIGIN` is unset, rather than `*` |
| Lambda-H3, S-M5 | Stale database connections | Node.js `initializeConnection.js` has `SELECT 1` health check (fixed), but Python `connect_to_db()` in all 6 Lambdas still lacks health check — partial layer fix | Verify Python Lambdas have health check in `connect_to_db()`; Python authorizer dependencies may fail on stale connections |
| DB-H1, S-M6 | SQL injection in credential creation | Parameterized query confirmed in `db_setup/index.js` but pattern should be verified: no other code path creates or modifies database users/passwords | Search codebase for `CREATE USER`, `ALTER USER`, `PASSWORD` SQL patterns outside db_setup |
| CDK-H2 | Cognito RETAIN comment | Comment corrected, but verify actual `removalPolicy` value has not changed — environment-dependent if CDK context overrides exist | Verify `cdk synth` output shows `DeletionPolicy: Retain` on the UserPool resource |

### Authentication Gaps Not Covered by Existing Reviews

The following authentication and authorization areas were NOT assessed by any of the 11 existing code review documents. These represent coverage gaps that the current authentication review (Sections 2–9) addresses:

| # | Gap Area | Description | Covered in This Review |
|---|----------|-------------|----------------------|
| 1 | **MFA enforcement strategy** | No existing review evaluates whether MFA is enabled/required on the Cognito User Pool, or whether adaptive MFA per role is appropriate for a legal content platform | §2 Cognito User Pool |
| 2 | **Cognito Advanced Security Features** | No review assesses whether adaptive authentication, compromised credential detection, or risk-based challenges are enabled | §2 Cognito User Pool |
| 3 | **Token validity TTL appropriateness** | No review evaluates whether 30-minute access/ID token TTLs are appropriate for the platform's threat model, or assesses refresh token configuration | §5 Token Lifecycle |
| 4 | **Refresh token rotation and revocation** | No review examines whether refresh token reuse detection is enabled, or what happens when a refresh token is stolen | §5 Token Lifecycle |
| 5 | **Session invalidation (force-logout)** | No review assesses admin ability to force-logout users, or whether role revocation propagates through the authorizer cache | §5 Token Lifecycle |
| 6 | **Frontend token storage mechanism** | Frontend review notes Amplify uses `sessionStorage` (positive) but no deep assessment of XSS risk, httpOnly migration path, or CSP coverage | §9 Frontend Session |
| 7 | **Authorizer cache key isolation** | No review assesses whether the 60-second cache key (Authorization token) ensures different users cannot share cached policies | §3 Lambda Authorizers |
| 8 | **WebSocket connection lifecycle re-auth** | No review assesses whether long-lived WebSocket connections require periodic re-authentication, or how token expiry affects active connections | §6 WebSocket Auth |
| 9 | **Cognito Pre-Signup trigger security** | No review assesses domain allowlist validation, wildcard bypass risk, or timing-based enumeration in the Pre-Signup trigger | §7 Cognito Triggers |
| 10 | **First-user-gets-admin race condition** | No review assesses whether simultaneous signups could both receive admin role due to lack of transaction/lock in `addStudentOnSignUp.js` | §7 Cognito Triggers |
| 11 | **Identity Pool role-mapping absence** | No review assesses whether the single authenticated IAM role (no role-mapping rules) creates a defense-in-depth gap | §8 Identity Pool |
| 12 | **Instructor-student relationship enforcement** | No review assesses whether instructor endpoints validate assignment relationships before returning student data | §4 RBAC |
| 13 | **Horizontal privilege escalation** | BOLA checks noted positively in Node.js review, but no systematic assessment of parameter manipulation attacks across all endpoints | §4 RBAC |
| 14 | **Logout implementation completeness** | No review assesses whether logout calls RevokeToken/GlobalSignOut, clears browser storage, and invalidates authorizer cache | §5 Token Lifecycle |
| 15 | **OWASP compliance mapping** | No existing review maps the platform against OWASP Authentication or Session Management Cheat Sheets | §11 OWASP Mapping |

### Deduplication Notes

The following findings appeared in multiple source documents and were consolidated using the highest severity:

| Consolidated Entry | Duplicated Across | Severity Used | Rationale |
|-------------------|-------------------|---------------|-----------|
| Authorizer mutable `responseStruct` | S-C3 (Critical), Node-C1 (Critical) | Critical | Both assess same bug; Security review elevates to Critical due to authorization bypass potential |
| Rate limit race condition | Lambda-C3 (Critical), S-H1 (High) | Critical | Lambda review classifies as Critical (directly exploitable); Security review as High (rate limit context) — using highest |
| Rate limit fail-open | Lambda-H1 (High), S-H2 (High) | High | Consistent severity across both sources |
| WebSocket throttling | S-H3 (High), CDK-M6 (Medium) | High | Security review elevates due to cost amplification attack vector |
| Playground no role check | S-M1 (Medium), Lambda-M3 (Medium), BDK-M4 (Medium) | Medium | Consistent across 3 sources; highest context from Bedrock review (fail-open behavior) |
| User enumeration | S-M2 (Medium), Node-M2 (Medium) | Medium | Consistent; both note same endpoint and deferred status |
| CORS wildcard fallback | S-M4 (Medium), Lambda-M4 (Medium) | Medium | Consistent severity; spans Python and Node.js layers |
| Stale DB connections | Lambda-H3 (High), S-M5 (Medium) | High | Lambda review rates as High (first request failure); Security as Medium (availability) — using highest |
| SQL injection in passwords | DB-H1 (High), S-M6 (Medium) | High | Database review rates as High (latent critical); Security as Medium (currently hex-only) — using highest |
| Secret rotation | RDS-C1 (High), WA-H5 (High) | High | Consistent across both sources; both assess same credential lifecycle gap |
| NAT Gateway SPOF (auth impact) | NW-H1 (High), CDK-H4 (High), WA-H3 (High) | High | Consistent; included for auth impact (authorizer Secrets Manager access failure) |
| dataTraceEnabled | CDK-M2 (Medium), S-H4 (High) | High | Security review elevates due to token/credential exposure in logs |

### Summary Statistics

| Metric | Value |
|--------|-------|
| Total auth-related findings extracted | 28 |
| After deduplication | 28 (consolidated entries) |
| ✅ Fixed | 12 (43%) |
| ⚠️ Partial | 1 (4%) |
| ⏸ Deferred | 4 (14%) |
| ⬜ Open | 11 (39%) |
| Re-verification recommended | 5 |
| Auth gaps not covered by prior reviews | 15 |

---

## 11. OWASP Compliance Mapping

**Status Legend:** ✅ Compliant | ⚠️ Partial | ❌ Non-Compliant | N/A Not Applicable

This section maps the platform's authentication, session management, credential storage, password recovery, and API security implementation against OWASP Cheat Sheet recommendations. Assessments are based on source code analysis completed in Sections 2–9 of this document.

---

### 11.1 OWASP Authentication Cheat Sheet Mapping

| # | OWASP Recommendation | Status | Evidence | Gap Description |
|---|---------------------|--------|----------|-----------------|
| 1 | **User IDs are case-insensitive** | ✅ Compliant | Cognito uses email as sign-in alias with built-in case normalization; `preSignup.js` lowercases email before whitelist lookup | — |
| 2 | **Implement proper password strength controls** | ⚠️ Partial | 12-char minimum with complexity rules (uppercase, lowercase, digit, symbol) exceeds OWASP 8-char minimum but uses composition rules NIST discourages; no breached password check | No compromised password detection (requires Advanced Security Features — AUTH-CUP-02, AUTH-CUP-05) |
| 3 | **Implement secure password recovery mechanism** | ✅ Compliant | Cognito `EMAIL_ONLY` account recovery with 6-digit verification code; `resetPassword()` + `confirmResetPassword()` flow in Login.tsx | — |
| 4 | **Store passwords in a secure fashion** | ✅ Compliant | Cognito manages all password hashing server-side using SRP verifiers (PBKDF2-based); no application-level password storage | — |
| 5 | **Transmit passwords only over TLS** | ⚠️ Partial | SRP (USER_SRP_AUTH) is enabled and used by default — password never leaves client. However, USER_PASSWORD_AUTH is also enabled, transmitting plaintext password over TLS | USER_PASSWORD_AUTH unnecessarily enabled (AUTH-CUP-03); redundant given SRP availability |
| 6 | **Require re-authentication for sensitive operations** | ❌ Non-Compliant | No re-authentication required for role elevation (`PUT /admin/user_role`), password change, or account deletion. Admin operations execute with existing session token. | No step-up authentication for privileged operations |
| 7 | **Implement multi-factor authentication** | ❌ Non-Compliant | MFA is completely disabled on the User Pool (`mfa` property absent, defaults to OFF). Users cannot enable MFA even optionally. | AUTH-CUP-01 — No MFA for any role including admin with full platform control |
| 8 | **Use authentication protocols that require no password** (WebAuthn/Passkeys) | N/A Not Applicable | Platform uses Cognito-managed authentication; WebAuthn integration is not a current requirement | Future enhancement opportunity |
| 9 | **Prevent brute-force attacks** | ⚠️ Partial | Cognito locks account after 5 failed attempts with exponential backoff; WAF rate limits (2000 req/5min per IP, 200/5min per auth header). No CAPTCHA, no distributed attack detection. | No Advanced Security Features (adaptive auth, bot detection); no CAPTCHA on login form (AUTH-FS-06); distributed credential stuffing undetected |
| 10 | **Log and monitor authentication failures** | ⚠️ Partial | Lambda authorizers log failures via Powertools logger to CloudWatch; WAF logs blocked requests. However, no aggregated auth failure alerting, no anomaly detection. | No CloudWatch alarm for auth failure rate spikes; no Cognito User Activity metrics (requires ASF) |
| 11 | **Prevent user enumeration** | ⚠️ Partial | Cognito `preventUserExistenceErrors` enabled by default for new App Clients (generic errors on sign-in). Pre-Signup trigger error messages reveal domain validation stage vs whitelist stage (AUTH-CT-04). `/student/get_name` allows email-based user lookup (S-M2). | Pre-Signup messages enable domain allowlist enumeration; user enumeration deferred as product decision |
| 12 | **Disable unused authentication functions** | ⚠️ Partial | CUSTOM_AUTH flow enabled but no custom triggers attached (dead configuration). USER_PASSWORD_AUTH enabled without justification given SRP availability. | AUTH-CUP-03 (USER_PASSWORD_AUTH) and AUTH-CUP-06 (CUSTOM_AUTH) are unnecessary |
| 13 | **Implement account lockout** | ✅ Compliant | Cognito built-in: 5 failed attempts → temporary lockout with exponential backoff. Non-configurable but effective baseline protection. | — |
| 14 | **Use secure comparison for credential validation** | ✅ Compliant | Cognito handles all password verification server-side using constant-time comparison within the SRP protocol. No application-level credential comparison exists. | — |
| 15 | **Protect against automated attacks** | ⚠️ Partial | WAF IP reputation list + rate limiting provide baseline protection. No CAPTCHA challenge, no device fingerprinting, no Advanced Security Features adaptive authentication. | AUTH-CUP-02 — ASF would add adaptive challenges for suspicious sign-ins |
| 16 | **Ensure all authentication decisions are logged** | ⚠️ Partial | Lambda authorizers log allow/deny decisions. Cognito authentication events logged in CloudTrail. No dedicated authentication audit table for rapid querying. | AUTH-RBAC-08 — Role changes lack dedicated audit trail; auth events scattered across CloudWatch log groups |

### 11.2 OWASP Session Management Cheat Sheet Mapping

| # | OWASP Recommendation | Status | Evidence | Gap Description |
|---|---------------------|--------|----------|-----------------|
| 1 | **Session ID generation uses cryptographically secure PRNG** | ✅ Compliant | Cognito generates JWT tokens with cryptographic signatures (RS256); token `jti` claim uses Cognito's internal CSPRNG. Session identifiers are not application-generated. | — |
| 2 | **Session ID length is sufficient** | ✅ Compliant | Cognito JWTs are ~1200+ characters (header.payload.signature); effectively unguessable via entropy. | — |
| 3 | **Session timeout: absolute (hard) timeout** | ⚠️ Partial | Access/ID token TTL: 30 minutes (effective session window). Refresh token TTL: 30 days (Cognito default — not explicitly configured). WebSocket connections: 2 hours max. | Refresh token 30-day TTL is excessive for legal content platform (AUTH-TL-01); no absolute session limit beyond refresh token lifetime |
| 4 | **Session timeout: idle timeout** | ❌ Non-Compliant | No idle/inactivity timeout implemented. Browser tab stays authenticated indefinitely via automatic token refresh. sessionStorage clears on tab close but no in-session idle detection. | AUTH-FS-02 — No idle timeout; user remains authenticated as long as tab is open (up to 30-day refresh token lifetime) |
| 5 | **Secure session ID exchange (transport security)** | ✅ Compliant | Tokens transmitted only via HTTPS (HSTS enforced with max-age=31536000). API Gateway rejects HTTP. Authorization header used for REST; Sec-WebSocket-Protocol for WebSocket. | — |
| 6 | **Session ID not exposed in URL** | ⚠️ Partial | REST API uses Authorization header (not URL). WebSocket has query string `?token=` fallback that exposes JWT in URL (AUTH-WS-01). | AUTH-WS-01 — Query string token parameter leaks credentials via URL |
| 7 | **Session fixation protection** | ✅ Compliant | Cognito issues new tokens on each authentication; no session ID reuse across logins. SRP protocol prevents session adoption. Token rotation on refresh ensures new tokens per cycle. | — |
| 8 | **Session invalidation on logout** | ⚠️ Partial | `signOut()` clears sessionStorage (local-only). Refresh token revoked by Amplify SDK default. Access/ID tokens NOT invalidated server-side — remain valid for 30 minutes. No `GlobalSignOut` call. | AUTH-TL-02 — Local signout only; captured tokens valid until expiry. AUTH-TL-03 — No admin force-logout capability |
| 9 | **Cookie security attributes** (Secure, HttpOnly, SameSite, Path, Domain) | N/A Not Applicable | Platform uses bearer token architecture (sessionStorage), not cookie-based sessions. Cognito may set internal cookies but they are not used for API authorization. | Not applicable to bearer token architecture; however, sessionStorage tokens are accessible to JavaScript (XSS risk — AUTH-FS-01) |
| 10 | **Session ID regeneration after privilege change** | ⚠️ Partial | Token refresh occurs every ~30 minutes via Amplify SDK, which generates new tokens. However, role elevation does not trigger immediate token refresh — user retains old token claims until natural refresh cycle. | Role changes not reflected in token until next refresh cycle (mitigated by database-based role enforcement in authorizers) |
| 11 | **Concurrent session control** | ❌ Non-Compliant | No concurrent session detection or limiting. Unlimited simultaneous sessions across devices. No "active sessions" view for users or admins. | AUTH-FS-03 — Multiple concurrent sessions permitted without visibility or control |
| 12 | **Session data protection on client** | ⚠️ Partial | Tokens stored in sessionStorage (cleared on tab close — better than localStorage). CSP configured but weakened by `unsafe-inline`/`unsafe-eval`. No httpOnly protection possible with Amplify SDK. | AUTH-FS-01 — CSP `unsafe-inline`/`unsafe-eval` weakens XSS defense; tokens accessible to any page JavaScript |
| 13 | **Session management event logging** | ⚠️ Partial | Cognito logs authentication events to CloudTrail. Lambda authorizers log per-request decisions. No session creation/destruction audit trail aggregation. | No consolidated session activity view; no alerting on unusual session patterns |

### 11.3 OWASP Credential Storage Mapping

| # | OWASP Recommendation | Status | Evidence | Gap Description |
|---|---------------------|--------|----------|-----------------|
| 1 | **Use modern hashing algorithms** (Argon2id, bcrypt, scrypt) | ✅ Compliant | Cognito uses SRP (Secure Remote Password) protocol with server-side PBKDF2-based verifiers. The password verifier is derived using a computationally expensive process. Hashing is entirely managed by Cognito — no application-level password storage. | — |
| 2 | **Use sufficient work factors** | ✅ Compliant | Cognito manages work factors internally (not configurable). AWS maintains Cognito's cryptographic parameters at current industry-recommended levels. | — |
| 3 | **Use unique salt per credential** | ✅ Compliant | Cognito's SRP implementation uses the username as part of the salt derivation, ensuring per-user uniqueness. Server-side verifier storage uses additional random salt. | — |
| 4 | **No plaintext credentials in code or config** | ⚠️ Partial | No user passwords stored in application code. Database credentials stored in Secrets Manager (encrypted). However: `SecretValue.unsafePlainText("applicationPassword")` placeholder appears in CDK templates (RDS-L1). | RDS-L1 — Placeholder password visible in synthesized CloudFormation templates; should use SecretsManager-generated secrets for all credentials |
| 5 | **No credentials stored outside designated secure stores** | ⚠️ Partial | Cognito manages user credentials. DB credentials in Secrets Manager. IDP credentials in Secrets Manager. However, credentials are cached at module scope in Lambda execution contexts for the context lifetime. | AUTH-LA-05 — DB credentials cached in Lambda memory for execution context lifetime; no rotation detection |
| 6 | **Credential storage isolated from application data** | ✅ Compliant | User authentication credentials stored in Cognito (separate AWS service). Database credentials stored in Secrets Manager (separate from application database). RDS Proxy mediates database connections. | — |
| 7 | **No credential exposure in logs** | ⚠️ Partial | Authorizer error handling masks credentials from client responses. Login.tsx has no `console.log()` of passwords. However: `dataTraceEnabled: true` (CDK-M2) can log full request bodies including tokens; WebSocket echoes JWT in response header (Node-H3). | CDK-M2/S-H4 — `dataTraceEnabled` logs tokens in CloudWatch; AUTH-WS-04 — JWT echoed in Sec-WebSocket-Protocol response |
| 8 | **Implement automatic credential rotation** | ❌ Non-Compliant | No automatic secret rotation configured for database credentials in Secrets Manager. Compromised credentials have unlimited lifetime until manually rotated. | RDS-C1/WA-H5 — No automatic secret rotation for DB credentials used by authorizers and handlers |

### 11.4 OWASP Forgot Password Cheat Sheet Mapping

| # | OWASP Recommendation | Status | Evidence | Gap Description |
|---|---------------------|--------|----------|-----------------|
| 1 | **Use a side channel for recovery** (email/SMS) | ✅ Compliant | Cognito uses `EMAIL_ONLY` account recovery. `resetPassword({ username })` triggers email delivery of a 6-digit verification code via Cognito. No security questions or knowledge-based recovery. | — |
| 2 | **Recovery response does not reveal user existence** | ⚠️ Partial | `preventUserExistenceErrors` enabled by default on App Client — sign-in and recovery flows return generic errors. However, sign-up flow inherently reveals if email is taken. Pre-Signup trigger messages differentiate domain vs whitelist rejection (AUTH-CT-04). | AUTH-CT-04 — Pre-Signup error messages reveal validation stage; sign-up inherently reveals taken emails (protocol limitation) |
| 3 | **Recovery codes/tokens have appropriate expiration** | ⚠️ Partial | Cognito verification code default expiration: 24 hours (for forgot-password) and configurable via `VerificationMessageTemplate`. The 24-hour window is longer than the OWASP-recommended maximum of 1 hour for password reset codes. | AUTH-CUP-07 — 24-hour code validity is excessive; OWASP recommends ≤1 hour for password reset codes |
| 4 | **Recovery codes are single-use** | ✅ Compliant | Cognito verification codes are invalidated after successful use (`confirmResetPassword()` consumes the code). Cannot reuse a code after password is changed. | — |
| 5 | **Recovery codes are sufficiently random** | ✅ Compliant | Cognito generates 6-digit numeric codes using CSPRNG. With rate limiting in place, brute-force of 10^6 combinations is impractical within the validity window. | — |
| 6 | **Rate-limit password reset requests** | ⚠️ Partial | Cognito natively rate-limits `ForgotPassword` API calls per user (prevents enumeration flooding). WAF rate limiting (2000/5min per IP) provides additional protection. No per-user cooldown period between reset requests visible in application layer. | No explicit per-user cooldown between consecutive reset requests; relies on Cognito's internal rate limiting |
| 7 | **Notify user of password change** | ✅ Compliant | Cognito sends a confirmation email after successful password change/reset. This is built-in Cognito behavior enabled by default. | — |
| 8 | **Invalidate all existing sessions on password reset** | ⚠️ Partial | `confirmResetPassword()` in Cognito invalidates the refresh token lineage for the user. Access/ID tokens remain valid until their 30-minute TTL expires. No immediate `GlobalSignOut` is triggered on password change. | 30-minute window where old access tokens remain valid after password reset; relies on token expiry rather than immediate revocation |
| 9 | **Use HTTPS for all recovery flows** | ✅ Compliant | HSTS enforced on all frontend pages (max-age=31536000). Login.tsx (which handles reset flow) served exclusively over HTTPS. Cognito API calls are TLS-only. | — |
| 10 | **Do not send credentials via email** | ✅ Compliant | Recovery flow sends a 6-digit numeric code only — no passwords, no tokens, no clickable links in verification emails. HTML template contains only the code in a styled div. | — |

### 11.5 OWASP API Authentication Mapping

| # | OWASP Recommendation | Status | Evidence | Gap Description |
|---|---------------------|--------|----------|-----------------|
| 1 | **Tokens transmitted only over TLS** | ✅ Compliant | API Gateway HTTPS-only (no HTTP listener). HSTS enforced on frontend. WebSocket uses WSS (TLS). All token transmission encrypted in transit. | — |
| 2 | **Per-request token validation** | ⚠️ Partial | Lambda authorizers validate JWT signature, expiration, issuer, and audience on each invocation. However, API Gateway caches authorizer results for 60 seconds — requests within the cache window bypass validation entirely. | AUTH-LA-09 — 60-second authorizer cache means tokens are not validated on every request; cached Allow policy served for subsequent requests |
| 3 | **Token scope appropriately limited** | ⚠️ Partial | Access/ID token scope limited to 30-minute validity. Role enforcement via database check (not token claims). However: IAM policy resource uses `*/admin/*` wildcard covering all endpoints in a role path; Identity Pool grants invoke on all role paths. | AUTH-IP-01 — Identity Pool IAM role grants `execute-api:Invoke` on all role paths regardless of user's actual role |
| 4 | **Implement CORS to prevent cross-origin abuse** | ⚠️ Partial | CORS configured with `CorsAllowedOrigin` when `DomainName` CDK parameter is set. When NOT set, CORS falls back to `*` (wildcard) — any origin can interact with API. | AUTH-FS-07 — CORS defaults to wildcard when DomainName not configured; S-M4/Lambda-M4 — fall-open CORS pattern |
| 5 | **Token revocation mechanism available** | ⚠️ Partial | Token revocation enabled by default on App Client (refresh tokens revocable). `signOut()` revokes refresh token. However: no mechanism to revoke access/ID tokens before expiry; no admin force-revocation endpoint; no authorizer cache flush. | AUTH-TL-02 — No access/ID token revocation; AUTH-TL-03 — No admin force-logout; AUTH-LA-11 — No cache flush mechanism |
| 6 | **Validate token on server, not client** | ✅ Compliant | All token validation performed server-side by Lambda authorizers using `aws-jwt-verify` (RSA signature verification, issuer/audience/expiration checks). Frontend performs no security-relevant token validation. | — |
| 7 | **Use short-lived access tokens** | ✅ Compliant | Access and ID tokens configured with 30-minute TTL. Refresh tokens used for session continuity. This aligns with OWASP recommendation for sensitive applications. | — |
| 8 | **Implement rate limiting on authentication endpoints** | ✅ Compliant | WAF rate limiting: 2000 requests/5min per IP + 200 requests/5min per Authorization header. Cognito-native rate limiting on auth APIs. WebSocket stage throttle: 100 rps / 200 burst. | — |
| 9 | **Use standard authentication protocols** | ✅ Compliant | Platform uses OAuth 2.0 / OpenID Connect via Cognito (industry-standard). JWT tokens follow RFC 7519. SRP for password authentication. Bearer token pattern for API access. | — |
| 10 | **Protect against replay attacks** | ✅ Compliant | JWT tokens include `exp` (expiration), `iat` (issued-at), and `jti` (unique ID) claims. `aws-jwt-verify` validates expiration. API Gateway authorizer cache is keyed per-token (no cross-user replay). | — |
| 11 | **Implement proper error responses** | ✅ Compliant | All Lambda authorizers return consistent `"Unauthorized"` string on any failure (required by API Gateway for 401). No internal details (DB schema, error types, connection state) leaked to client. | — |
| 12 | **Separate authentication from authorization** | ✅ Compliant | Authentication: Cognito User Pool (identity verification). Authorization: Lambda authorizers (role validation via database). Application: Handler-level BOLA checks (object access). Three distinct layers with separation of concerns. | — |
| 13 | **Validate all inputs to authentication endpoints** | ✅ Compliant | JWT verification validates structure, signature, and claims. Database queries use parameterized queries (tagged template literals). Cognito validates email format and password policy on registration. | — |
| 14 | **Implement request signing or mutual TLS** | N/A Not Applicable | API uses bearer token authentication (standard for web applications). Mutual TLS and request signing are enterprise/B2B patterns not required for this platform's user authentication model. | — |
| 15 | **WebSocket authentication equivalent to REST** | ⚠️ Partial | WebSocket authorizer uses same JWT verification and database role check as REST authorizers. However: no message-level re-authentication; token passed via Sec-WebSocket-Protocol (non-standard); query string fallback leaks credentials. | AUTH-WS-01 — Query string token leakage; AUTH-WS-03 — No re-auth for long-lived connections; AUTH-WS-10 — Non-standard header usage |

### 11.6 Compliance Summary

| Category | Compliant | Partial | Non-Compliant | N/A | Overall Status | Remediation Priority |
|----------|-----------|---------|---------------|-----|----------------|---------------------|
| **Authentication Cheat Sheet** (16 items) | 5 (31%) | 8 (50%) | 2 (13%) | 1 (6%) | ⚠️ Partial | **Critical** — MFA and re-authentication gaps directly threaten privileged legal content |
| **Session Management** (13 items) | 4 (31%) | 7 (54%) | 2 (15%) | 0 (0%) | ⚠️ Partial | **High** — Idle timeout absence and concurrent session gaps increase unauthorized access window |
| **Credential Storage** (8 items) | 4 (50%) | 3 (38%) | 1 (12%) | 0 (0%) | ⚠️ Partial | **High** — Credential rotation gap (RDS-C1) has unlimited exposure window |
| **Forgot Password** (10 items) | 6 (60%) | 4 (40%) | 0 (0%) | 0 (0%) | ⚠️ Partial | **Medium** — Code expiration and session invalidation gaps are non-trivial but exploitability is limited |
| **API Authentication** (15 items) | 9 (60%) | 5 (33%) | 0 (0%) | 1 (7%) | ⚠️ Partial | **Medium** — Caching trade-offs and CORS gaps are acceptable risks with documented mitigations |

**Overall OWASP Compliance Posture:** ⚠️ **Partial Compliance** — 28 of 62 recommendations fully met (45%), 27 partially met (44%), 4 non-compliant (6%), 3 not applicable (5%).

**Key Compliance Gaps Requiring Immediate Attention:**

| Priority | Gap | OWASP Source | Finding IDs | Impact |
|----------|-----|-------------|-------------|--------|
| 1 (Critical) | No MFA available | Auth CS #7 | AUTH-CUP-01 | Single-factor auth for admin/instructor accessing privileged legal content |
| 2 (Critical) | No re-authentication for sensitive ops | Auth CS #6 | New (no existing finding) | Role elevation, user management performed without step-up auth |
| 3 (High) | No idle session timeout | Session CS #4 | AUTH-FS-02 | Unattended workstations remain authenticated indefinitely |
| 4 (High) | No automatic credential rotation | Cred Storage #8 | RDS-C1, WA-H5 | Compromised DB credentials have unlimited lifetime |
| 5 (High) | 30-day refresh token lifetime | Session CS #3 | AUTH-TL-01 | Stolen refresh token provides month-long persistent access |
| 6 (High) | No concurrent session control | Session CS #11 | AUTH-FS-03 | Unlimited parallel sessions without detection |
| 7 (Medium) | Authorizer cache bypasses per-request validation | API Auth #2 | AUTH-LA-09 | 60-second window of un-validated access after role revocation |
| 8 (Medium) | CORS wildcard fallback | API Auth #4 | AUTH-FS-07, S-M4 | Misconfigured deployments allow cross-origin API abuse |

**Compliance Trend by Domain:**

| Platform Domain | OWASP Categories Most Affected | Primary Gaps |
|----------------|-------------------------------|--------------|
| Cognito User Pool | Authentication CS | MFA, ASF, brute-force detection |
| Lambda Authorizers | API Authentication | Caching, logging completeness |
| RBAC | Authentication CS, API Auth | Re-authentication, audit trail |
| Token Lifecycle | Session Management, API Auth | Refresh TTL, revocation, idle timeout |
| WebSocket Auth | API Authentication, Session | Re-auth, credential exposure, WAF |
| Cognito Triggers | Authentication CS | User enumeration, existence leakage |
| Identity Pool | API Authentication | Token scope, role mapping |
| Frontend Session | Session Management | Idle timeout, CSP, concurrent sessions |

---

## 12. Remediation Priority Matrix

### Priority Scoring Methodology

Priority is determined by sorting all findings by severity (descending) then effort (ascending). This ensures critical issues with low implementation effort are addressed first.

**Severity Weights:** Critical = 4, High = 3, Medium = 2, Low = 1
**Effort Weights:** Low = 1, Medium = 2, High = 3
**Priority Score:** Severity Weight / Effort Weight (higher = fix sooner)

### Sprint Assignment Criteria

| Suggested Sprint | Criteria |
|-----------------|----------|
| **Immediate** | Critical severity, or High severity with Low effort |
| **Next Sprint** | High severity with Medium/High effort, or Medium severity with Low effort |
| **Backlog** | Medium severity with Medium/High effort, or Low severity |

### Priority Matrix

| Rank | Finding ID | Title | Severity | Effort | Score | Sprint | Dependencies |
|------|-----------|-------|----------|--------|-------|--------|--------------|
| 1 | AUTH-CUP-01 | MFA completely disabled — single-factor auth for all roles including admin | Critical | Medium | 2.00 | Immediate | AUTH-CUP-02 (ASF enables adaptive MFA) |
| 2 | AUTH-CUP-02 | Advanced Security Features not enabled — no adaptive auth or breached password detection | High | Low | 3.00 | Immediate | None |
| 3 | AUTH-CUP-05 | No breached password detection — compromised credentials accepted | High | Low | 3.00 | Immediate | AUTH-CUP-02 (ASF provides this) |
| 4 | AUTH-TL-01 | Refresh token TTL defaults to 30 days — excessive for legal content platform | High | Low | 3.00 | Immediate | None |
| 5 | AUTH-TL-02 | Logout does not revoke server-side tokens — local-only signout | High | Low | 3.00 | Immediate | None |
| 6 | AUTH-WS-01 | Query string token parameter exposes JWT in URL (log leakage) | High | Low | 3.00 | Immediate | None |
| 7 | AUTH-WS-02 | WebSocket API has no WAF Web ACL — unprotected against DDoS and credential stuffing | High | Low | 3.00 | Immediate | None |
| 8 | AUTH-CT-01 | First-user-gets-admin race condition — concurrent signups both get admin | High | Medium | 1.50 | Next Sprint | None |
| 9 | AUTH-CT-02 | Post-confirmation trigger returns success on DB failure — split-state user provisioning | High | Medium | 1.50 | Next Sprint | None |
| 10 | AUTH-TL-04 | No production Content Security Policy — XSS faces no browser restriction | High | Medium | 1.50 | Next Sprint | AUTH-FS-01 (same CSP fix) |
| 11 | AUTH-WS-03 | No re-authentication for long-lived WebSocket connections (up to 2 hours stale) | High | Medium | 1.50 | Next Sprint | AUTH-WS-05 |
| 12 | AUTH-RBAC-02 | First-user-admin race condition (same as AUTH-CT-01) | High | Medium | 1.50 | Next Sprint | AUTH-CT-01 (same fix) |
| 13 | AUTH-RBAC-05 | Post-confirmation returns success on DB failure (same as AUTH-CT-02) | High | Medium | 1.50 | Next Sprint | AUTH-CT-02 (same fix) |
| 14 | AUTH-FS-01 | CSP allows `unsafe-inline` and `unsafe-eval` in script-src | High | High | 1.00 | Next Sprint | None |
| 15 | Lambda-H3/S-M5 | Stale database connections in Python Lambdas — partial fix (Node.js only) | High | Medium | 1.50 | Next Sprint | None |
| 16 | Node-H3 | WebSocket token echoed in Sec-WebSocket-Protocol response header | High | Medium | 1.50 | Next Sprint | AUTH-WS-04 (same fix) |
| 17 | AUTH-CUP-03 | USER_PASSWORD_AUTH enabled alongside SRP — unnecessary plaintext password flow | Medium | Low | 2.00 | Next Sprint | None |
| 18 | AUTH-LA-09 | 60-second authorizer cache creates role revocation delay | Medium | Low | 2.00 | Next Sprint | None |
| 19 | AUTH-WS-04 | Sec-WebSocket-Protocol echo exposes JWT in response headers | Medium | Low | 2.00 | Next Sprint | None |
| 20 | AUTH-WS-06 | No per-IP rate limiting on failed WebSocket $connect attempts | Medium | Low | 2.00 | Next Sprint | AUTH-WS-02 (WAF provides this) |
| 21 | AUTH-WS-07 | wsAuthorizer userMetadataCache grows unbounded with no TTL | Medium | Low | 2.00 | Next Sprint | AUTH-LA-01 (same pattern fix) |
| 22 | AUTH-CT-04 | Pre-Signup error messages reveal which validation stage failed | Medium | Low | 2.00 | Next Sprint | None |
| 23 | AUTH-CT-05 | Wildcard domain (`*`) in allowlist bypasses all domain restrictions | Medium | Low | 2.00 | Next Sprint | None |
| 24 | AUTH-CT-06 | SignupMode SSM defaults to "public" on read failure — silent downgrade from whitelist mode | Medium | Low | 2.00 | Next Sprint | None |
| 25 | AUTH-TL-05 | Development CSP uses `unsafe-inline`/`unsafe-eval` — must not propagate to production | Medium | Low | 2.00 | Next Sprint | AUTH-TL-04, AUTH-FS-01 |
| 26 | AUTH-TL-09 | `connect-src` allows all HTTPS/WSS — no origin restriction on token-bearing requests | Medium | Low | 2.00 | Next Sprint | AUTH-TL-04 (same CSP fix) |
| 27 | AUTH-FS-07 | CORS defaults to wildcard when DomainName not configured | Medium | Low | 2.00 | Next Sprint | None |
| 28 | S-M1/Lambda-M3/BDK-M4 | Playground Lambda has no direct role-based authorization (relies on WS router only) | Medium | Low | 2.00 | Next Sprint | None |
| 29 | Lambda-M2 | SSM parameters never refreshed on warm starts — config changes require Lambda recycle | Medium | Low | 2.00 | Next Sprint | None |
| 30 | AUTH-RBAC-01 | Admin self-elevation not prevented — no two-person rule for admin changes | Medium | Low | 2.00 | Next Sprint | AUTH-RBAC-08 (audit trail) |
| 31 | AUTH-LA-01 | User metadata cache has no TTL — deleted users retain access | Medium | Medium | 1.00 | Backlog | None |
| 32 | AUTH-LA-06 | ForceRefresh does not detect user deletion — cache holds stale valid record | Medium | Medium | 1.00 | Backlog | AUTH-LA-01 (same TTL fix) |
| 33 | AUTH-LA-10 | Student authorizer cached policy bypasses route-specific logic for 60s | Medium | Medium | 1.00 | Backlog | AUTH-LA-09 (reduce TTL helps) |
| 34 | AUTH-LA-11 | No mechanism to invalidate API Gateway authorizer cache on demand | Medium | High | 0.67 | Backlog | AUTH-TL-03 (force-logout related) |
| 35 | AUTH-RBAC-06 | WebSocket role revocation gap — up to 2 hours of stale access | Medium | Medium | 1.00 | Backlog | AUTH-WS-03 (re-auth solves this) |
| 36 | AUTH-RBAC-07 | No message-level case ownership validation in WebSocket default handler | Medium | Medium | 1.00 | Backlog | AUTH-WS-09 (same fix) |
| 37 | AUTH-RBAC-08 | No audit trail for admin role changes | Medium | Medium | 1.00 | Backlog | None |
| 38 | AUTH-TL-03 | No admin force-logout capability | Medium | Medium | 1.00 | Backlog | None |
| 39 | AUTH-TL-06 | WebSocket connections survive token expiration without server-side termination | Medium | Medium | 1.00 | Backlog | AUTH-WS-03 (same fix) |
| 40 | AUTH-TL-07 | No idle session timeout implemented | Medium | Medium | 1.00 | Backlog | None |
| 41 | AUTH-WS-05 | default.js uses $connect-time cached roles — revocation not propagated | Medium | Medium | 1.00 | Backlog | AUTH-WS-03 |
| 42 | AUTH-WS-09 | generate_text, summary, audio, assess_progress lack message-level role enforcement | Medium | Medium | 1.00 | Backlog | None |
| 43 | AUTH-IP-01 | Overly broad IAM policy — all users get invoke on all role paths | Medium | Medium | 1.00 | Backlog | AUTH-IP-03 (removal eliminates this) |
| 44 | AUTH-FS-02 | No idle/inactivity timeout — sessions persist indefinitely while tab open | Medium | Medium | 1.00 | Backlog | None |
| 45 | AUTH-FS-04 | Logout does not invalidate access/ID tokens — valid for 30 min post-logout | Medium | Medium | 1.00 | Backlog | AUTH-TL-02 (GlobalSignOut) |
| 46 | AUTH-CT-03 | No Cognito-to-database reconciliation mechanism | Medium | High | 0.67 | Backlog | AUTH-CT-02 (prevents new orphans) |
| 47 | AUTH-IP-02 | No role-mapping rules — no IAM-level role differentiation | Medium | High | 0.67 | Backlog | AUTH-IP-03 (removal eliminates this) |
| 48 | AUTH-IP-03 | Identity Pool appears unnecessary — increases attack surface without functional benefit | Medium | Medium | 1.00 | Backlog | None |
| 49 | AUTH-FS-03 | No concurrent session detection or limiting | Medium | High | 0.67 | Backlog | None |
| 50 | Node-M1 | Massive code duplication across 4 authorizer functions | Medium | Medium | 1.00 | Backlog | AUTH-LA-08 (same finding) |
| 51 | AUTH-CUP-04 | Password composition rules contrary to NIST SP 800-63B | Low | Low | 1.00 | Backlog | AUTH-CUP-02 (ASF enables breached password check as alternative) |
| 52 | AUTH-CUP-06 | CUSTOM_AUTH flow enabled with no triggers attached | Low | Low | 1.00 | Backlog | AUTH-CUP-03 (same CDK change) |
| 53 | AUTH-LA-02 | No `email_verified` claim validation in JWT | Low | Low | 1.00 | Backlog | None |
| 54 | AUTH-LA-03 | Inconsistent `roles` array type handling across authorizers | Low | Low | 1.00 | Backlog | AUTH-LA-08 (refactor fixes this) |
| 55 | AUTH-TL-08 | Token revocation relies on implicit CDK default — not explicit | Low | Low | 1.00 | Backlog | None |
| 56 | AUTH-WS-08 | `lastActivity` written at connect but never updated — ineffective for idle detection | Low | Low | 1.00 | Backlog | None |
| 57 | AUTH-FS-05 | Token refresh failure has no explicit UI handling | Low | Low | 1.00 | Backlog | None |
| 58 | AUTH-FS-08 | `connect-src` permissive when no custom domain configured | Low | Low | 1.00 | Backlog | AUTH-TL-04 (same CSP fix) |
| 59 | AUTH-IP-04 | STS credentials irrevocable for 1-hour window | Low | Low | 1.00 | Backlog | AUTH-IP-03 (removal eliminates this) |
| 60 | AUTH-IP-05 | Wildcard stage/method in Identity Pool resource ARNs | Low | Low | 1.00 | Backlog | AUTH-IP-03 (removal eliminates this) |
| 61 | AUTH-RBAC-03 | Instructor handler missing redundant role check (defense-in-depth gap) | Low | Low | 1.00 | Backlog | None |
| 62 | AUTH-RBAC-09 | elevate_instructor replaces student role instead of appending | Low | Low | 1.00 | Backlog | None |
| 63 | AUTH-CUP-07 | Verification code validity 24 hours (excessive) | Low | Medium | 0.50 | Backlog | None |
| 64 | AUTH-LA-04 | Cold-start latency from dual Secrets Manager + JWKS + DB connection | Low | Medium | 0.50 | Backlog | None |
| 65 | AUTH-LA-05 | DB credentials cached for execution context lifetime — no rotation handling | Low | Medium | 0.50 | Backlog | None |
| 66 | AUTH-LA-07 | Student authorizer hardcodes route lists — maintenance coupling | Low | Medium | 0.50 | Backlog | AUTH-LA-08 (refactor addresses) |
| 67 | AUTH-LA-08 | Near-complete code duplication across three authorizer files | Low | Medium | 0.50 | Backlog | None |
| 68 | AUTH-RBAC-04 | No BOLA checks in admin handler — unrestricted data access | Low | Medium | 0.50 | Backlog | None |
| 69 | AUTH-FS-06 | No CAPTCHA or progressive delay after failed login attempts | Low | Medium | 0.50 | Backlog | AUTH-CUP-02 (ASF adds bot detection) |
| 70 | AUTH-WS-10 | Sec-WebSocket-Protocol misuse for credential transport | Low | High | 0.33 | Backlog | None |
| 71 | Frontend-L2 | Password stored briefly in React state during auto-login after signup | Low | Low | 1.00 | Backlog | None |

### Dependency Chains

The following dependency chains identify fixes that should be completed in sequence for maximum effectiveness:

**Chain 1 — Cognito Security Features (Immediate):**
```
AUTH-CUP-02 (Enable ASF) → AUTH-CUP-05 (Breached password detection — included in ASF)
                          → AUTH-CUP-01 (MFA — ASF enables adaptive MFA challenges)
```

**Chain 2 — WebSocket Security (Immediate → Next Sprint):**
```
AUTH-WS-02 (WAF association) → AUTH-WS-06 (Per-IP rate limiting — WAF provides this)
AUTH-WS-01 (Remove query string token) → AUTH-WS-04 (Fix protocol echo)
AUTH-WS-03 (Re-authentication) → AUTH-WS-05 (Roles refresh)
                                → AUTH-RBAC-06 (WS role revocation gap)
                                → AUTH-TL-06 (Connection survives token expiry)
```

**Chain 3 — Content Security Policy (Next Sprint):**
```
AUTH-TL-04 / AUTH-FS-01 (Production CSP) → AUTH-TL-05 (Remove unsafe-inline/eval)
                                          → AUTH-TL-09 (Restrict connect-src)
                                          → AUTH-FS-08 (Tighten non-domain CSP)
```

**Chain 4 — User Provisioning Integrity (Next Sprint):**
```
AUTH-CT-01 / AUTH-RBAC-02 (Fix first-user race) — standalone fix
AUTH-CT-02 / AUTH-RBAC-05 (Fix DB failure handling) → AUTH-CT-03 (Reconciliation mechanism)
```

**Chain 5 — Session Lifecycle (Immediate → Backlog):**
```
AUTH-TL-02 (Global signout on logout) → AUTH-FS-04 (Token invalidation on logout)
AUTH-TL-01 (Reduce refresh token TTL) — standalone fix
AUTH-TL-03 (Admin force-logout) → AUTH-LA-11 (Cache flush mechanism)
AUTH-TL-07 / AUTH-FS-02 (Idle timeout) — standalone fix
```

**Chain 6 — Lambda Authorizer Hardening (Backlog):**
```
AUTH-LA-08 / Node-M1 (Refactor to shared module) → AUTH-LA-03 (Consistent type handling)
                                                  → AUTH-LA-07 (Externalize route config)
AUTH-LA-01 (TTL on cache) → AUTH-LA-06 (Deletion detection)
                           → AUTH-WS-07 (WS authorizer same fix)
```

**Chain 7 — Identity Pool (Backlog):**
```
AUTH-IP-03 (Remove Identity Pool) → AUTH-IP-01 (eliminates broad IAM)
                                   → AUTH-IP-02 (eliminates role-mapping gap)
                                   → AUTH-IP-04 (eliminates STS credential risk)
                                   → AUTH-IP-05 (eliminates wildcard ARNs)
```

### Sprint Summary

| Sprint | Finding Count | Key Deliverables |
|--------|--------------|-----------------|
| **Immediate** (this week) | 7 | Enable ASF, reduce refresh TTL, fix logout, remove WS query token, associate WS WAF |
| **Next Sprint** | 23 | Fix race conditions, production CSP, WS re-auth, remove USER_PASSWORD_AUTH, unify error messages, address Python stale connections |
| **Backlog** | 41 | Authorizer refactoring, idle timeout, Identity Pool removal, audit trail, reconciliation, concurrent sessions |

---

## Appendix

### Source Files Analyzed

| File | Assessment Domain(s) |
|------|---------------------|
| `cdk/lib/api-stack.ts` | Cognito User Pool, Identity Pool, Token Lifecycle |
| `cdk/lambda/authorization/adminAuthorizerFunction.js` | Lambda Authorizers, RBAC |
| `cdk/lambda/authorization/instructorAuthorizerFunction.js` | Lambda Authorizers, RBAC |
| `cdk/lambda/authorization/studentAuthorizerFunction.js` | Lambda Authorizers, RBAC |
| `cdk/lambda/authorization/wsAuthorizer.js` | WebSocket Auth, Lambda Authorizers |
| `cdk/lambda/authorization/preSignup.js` | Cognito Triggers |
| `cdk/lambda/authorization/addStudentOnSignUp.js` | Cognito Triggers, RBAC |
| `cdk/lambda/handlers/utils/authorization.js` | RBAC |
| `cdk/lambda/handlers/adminFunction.js` | RBAC |
| `cdk/lambda/handlers/instructorFunction.js` | RBAC |
| `cdk/lambda/handlers/studentFunction.js` | RBAC |
| `cdk/lambda/websocket/connect.js` | WebSocket Auth |
| `cdk/lambda/websocket/disconnect.js` | WebSocket Auth |
| `cdk/lambda/websocket/default.js` | WebSocket Auth |
| `cdk/OpenAPI_Swagger_Definition.yaml` | Lambda Authorizers, RBAC |
| `frontend/src/pages/Login.tsx` | Frontend Session, Token Lifecycle |
| `frontend/src/contexts/` | Frontend Session |

### References

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [OWASP Credential Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [NIST SP 800-63B — Digital Identity Guidelines](https://pages.nist.gov/800-63-3/sp800-63b.html)
- [AWS Cognito Security Best Practices](https://docs.aws.amazon.com/cognito/latest/developerguide/security.html)
- [AWS Lambda Authorizer Documentation](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html)
