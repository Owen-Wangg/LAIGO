# Code Review: Networking, WAF & Transport Security

**Reviewer:** Kiro  
**Date:** 2025-07-22  
**Scope:** VPC architecture, security groups, WAF configurations (CloudFront + API Gateway), transport security (TLS/SSL), network monitoring, API Gateway security, and cross-cutting networking findings consolidation (`cdk/lib/vpc-stack.ts`, `cdk/lib/database-stack.ts`, `cdk/lib/api-stack.ts`, `cdk/lib/waf-stack.ts`, `cdk/lambda/`)  
**Methodology:** Systematic infrastructure code analysis following a 6-phase approach — (1) Infrastructure Code Analysis, (2) WAF Rule Assessment, (3) Transport Security Audit, (4) Monitoring Gap Analysis, (5) Cross-Reference Consolidation, (6) Prioritized Recommendations  
**Finding ID Format:** `NW-{severity_initial}{number}` where severity_initial is C (Critical), H (High), M (Medium), or L (Low). Example: `NW-H1`  
**Status:** Complete

---

## Severity Classification Criteria

| Severity | Definition |
|----------|-----------|
| Critical | Exploitable without authentication, or leads to full system compromise, or data exfiltration of privileged legal content |
| High | Exploitable by authenticated user, creates significant exposure, or leaves a major gap in defense-in-depth |
| Medium | Requires specific conditions to exploit, represents defense-in-depth gap, or deviates from security best practice |
| Low | Informational, hardening opportunity, or cosmetic security improvement |

## Effort Classification Criteria

| Effort | Definition |
|--------|-----------|
| Low | Configuration-only change, <1 day, no code modification, CDK parameter adjustment |
| Medium | Code or infrastructure change, 1–5 days, may require testing/staging |
| High | Architectural change, >5 days, requires design work and multi-sprint effort |

## Finding Schema

Each finding includes: ID, title, severity, section, current state (with code evidence), gap, risk (attack vector + impact), recommendation (specific actionable fix), effort, cross-references to existing findings, and status (New/Open/Partial/Fixed/Deferred).

---

## Summary

| Severity | Count | New | Open | Deferred |
|----------|-------|-----|------|----------|
| Critical | 0     | 0   | 0    | 0        |
| High     | 16    | 13  | 3    | 0        |
| Medium   | 24    | 24  | 0    | 0        |
| Low      | 8     | 7   | 0    | 1        |
| **Total**| **48**| **44** | **3** | **1** |

> 48 findings identified across 10 assessment sections. No Critical-severity findings. 16 High-severity findings demand immediate attention — 11 are Low-effort configuration changes achievable within days.

---

## 1. Executive Summary

**Overall Posture Rating: Moderate with Significant Gaps**

The LAIGO platform demonstrates a sound foundational network architecture — 3-tier VPC subnet isolation, WAF presence at both CloudFront and API Gateway layers, TLS enforcement on database connections via RDS Proxy, and VPC Flow Logs enabled. However, significant gaps exist in operational monitoring, WAF rule tuning for the legal AI use case, and defense-in-depth enforcement that collectively reduce the posture below production-ready for a platform handling privileged legal content.

**Key Metrics:**
- Total findings: 48 (0 Critical, 16 High, 24 Medium, 8 Low)
- High-severity findings requiring immediate action: 16 (11 are Low-effort, achievable within days)
- Findings from prior reviews still unresolved: 6 High-severity (NAT SPOF, VPC-wide SG rule, no monitoring alarms, WebSocket token exposure, RDS Single-AZ, dataTraceEnabled)
- New gaps discovered by this review: 44 findings not previously identified
- Findings that are functionally breaking platform features: 1 (SizeRestrictions_BODY 8 KB limit blocks legal content submissions)

**What's Working Well:**
- Database tier correctly isolated in PRIVATE_ISOLATED subnets (new VPC path) with no internet route
- RDS Proxy enforces TLS (`requireTLS: true`) and `rds.force_ssl = 1` rejects plaintext connections
- All Lambda authorizers validate JWT tokens and enforce role-based access consistently
- No resources deployed in public subnets beyond the NAT Gateway (correct architecture)
- VPC Flow Logs enabled on both deployment paths (captures ALL traffic)
- API Gateway stage throttling configured at 100 req/s with 200 burst (adequate for current scale)
- WebSocket API has Lambda authorizer, stage throttling, and per-user connection limits
- All communication paths use TLS 1.2+ minimum (no legacy protocol support)

**Top 5 Most Impactful Findings:**

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 1 | **No WAF logging on either ACL** — complete blind spot for incident response, false-positive tuning, and compliance | Blocks all other WAF improvement work; prerequisite for safe rule additions | Low |
| 2 | **No CloudWatch Alarms for network security** — zero automated detection of DDoS, scanning, NAT failures, or API degradation | Incidents go undetected until users report outages; MTTD measured in hours/days | Low |
| 3 | **Certificate validation disabled** (`rejectUnauthorized: false`) in REST API handlers — MITM possible within VPC | All REST API traffic (3 role handlers) uses broken TLS validation; privileged legal content at risk | Low |
| 4 | **SizeRestrictions_BODY (8 KB) blocks legitimate legal content** — core AI features non-functional for documents > 8 KB | Platform's primary value (AI-assisted legal analysis) is broken for real-world document sizes | Low |
| 5 | **Single NAT Gateway SPOF** — AZ failure takes down all 13+ Lambda functions including all AI features | Total platform unavailability during a single-AZ event; no fallback for Bedrock, Transcribe, or EventBridge | Low |

**Key Remediation Priorities:**

1. **Enable WAF logging** (prerequisite for all WAF tuning) — both ACLs, CloudWatch Logs destination, 90-day retention
2. **Deploy CloudWatch Alarms** — minimum set covering WAF block spikes, NAT errors, API 5xx rates, and VPC Flow Log anomalies
3. **Fix TLS validation** — change `rejectUnauthorized: false` to `ssl: "require"` in REST handlers and add `sslmode: 'require'` to Python Lambdas
4. **Exclude SizeRestrictions_BODY** from CommonRuleSet and add custom size constraints (1 MB for AI endpoints)
5. **Add second NAT Gateway** for production HA (`natGateways: isProd ? 2 : 1`)
6. **Add free VPC Gateway endpoints** (S3, DynamoDB) — zero cost, immediate reliability improvement
7. **Replace VPC-wide CIDR security group rule** with security-group-reference-based rules for database access
8. **Disable `dataTraceEnabled`** in production — privileged legal content should not be logged to CloudWatch

**Assessment Scope Covered:**
- VPC architecture and subnet isolation (§2)
- Security group least-privilege enforcement (§3)
- WAF rule coverage — CloudFront (§4) and API Gateway (§5)
- Transport security (TLS/SSL) across all communication paths (§6)
- Network monitoring and logging (§7)
- API Gateway security configuration (§8)
- Cross-cutting findings from 10 existing code reviews (§9)
- WAF effectiveness against OWASP Top 10 (§10)
- Production readiness recommendations — NACLs, VPC endpoints, Network Firewall (§11)

---

## 2. VPC Architecture Assessment

> *Requirement 1: Document VPC Architecture and Subnet Isolation Assessment*

This section assesses the VPC topology, subnet isolation strategy, NAT Gateway resilience, VPC endpoints, and public subnet exposure based on analysis of `cdk/lib/vpc-stack.ts` and `cdk/lib/database-stack.ts`.

### 2.1 VPC Topology

The VPC stack supports two deployment paths:

**Path A — New VPC (Default, `existingVpcId === ""`):**

| Subnet Tier | CIDR Range | AZs | Purpose |
|-------------|-----------|-----|---------|
| `public-subnet-1` (PUBLIC) | Auto-assigned from 10.0.0.0/16 | 2 (maxAzs: 2) | NAT Gateway hosting, internet-facing resources |
| `private-subnet-1` (PRIVATE_WITH_EGRESS) | Auto-assigned from 10.0.0.0/16 | 2 | Lambda functions requiring internet access (Bedrock, Transcribe, external APIs) via NAT |
| `isolated-subnet-1` (PRIVATE_ISOLATED) | Auto-assigned from 10.0.0.0/16 | 2 | RDS database, RDS Proxy, VPC Endpoints — no internet route |

- **VPC CIDR:** Configurable via CDK context `vpcCidr`, defaults to `10.0.0.0/16`
- **AZ Distribution:** 2 Availability Zones (CDK `maxAzs: 2`)
- **Subnet auto-allocation:** CDK evenly divides the /16 CIDR across 3 tiers × 2 AZs = 6 subnets

**Path B — Existing VPC (Control Tower, `existingVpcId !== ""`):**

| Subnet Tier | CIDR Range | AZs | Purpose |
|-------------|-----------|-----|---------|
| Public (created if not existing) | Configurable via `publicSubnetCidr`, default `172.31.94.0/20` | 1 (first AZ only) | NAT Gateway, Internet Gateway |
| Private (imported from Control Tower) | Imported via CloudFormation exports | 3 | Lambda functions, mapped as both PRIVATE and ISOLATED |
| Isolated (same IDs as private) | Same subnet IDs as private subnets | 3 | RDS placement — **see finding NW-H1** |

**Code Evidence (New VPC path):**
```typescript
// vpc-stack.ts lines 135-160
this.vpc = new ec2.Vpc(this, "laigo-Vpc", {
  ipAddresses: ec2.IpAddresses.cidr(this.vpcCidrString),
  natGatewayProvider: natGatewayProvider,
  natGateways: 1,
  maxAzs: 2,
  subnetConfiguration: [
    { name: "public-subnet-1", subnetType: ec2.SubnetType.PUBLIC },
    { name: "private-subnet-1", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    { name: "isolated-subnet-1", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  ],
});
```

### 2.2 Database Tier Isolation

**Current State:**

| Control | Status | Evidence |
|---------|--------|----------|
| RDS in PRIVATE_ISOLATED subnet | ✅ Confirmed | `database-stack.ts`: `vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }` |
| No Internet Gateway route | ✅ Confirmed (New VPC path) | CDK PRIVATE_ISOLATED subnets have no route to IGW or NAT by design |
| No public IP assignment | ✅ Confirmed | `publiclyAccessible: false` explicitly set |
| Access restricted to VPC CIDR on port 5432 | ⚠️ Partial | VPC-wide CIDR rule is overly permissive (see §3) |
| RDS Proxy in same isolated subnet | ✅ Confirmed | Proxy uses same security groups as RDS instance |
| Storage encryption at rest | ✅ Confirmed | `storageEncrypted: true` |
| TLS required for proxy connections | ✅ Confirmed | `requireTLS: true` on RDS Proxy |

**Assessment:** The database tier is correctly placed in isolated subnets with no internet route. The `rds.force_ssl` parameter is set to `1` in the custom parameter group, ensuring non-SSL connections are rejected. However, the VPC-wide CIDR ingress rule (analyzed in detail in §3) means any VPC resource can reach port 5432, not just authorized Lambdas. This is a least-privilege violation documented as an existing finding (RDS-H2).

**Code Evidence:**
```typescript
// database-stack.ts — RDS instance placement
this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
  vpc: vpcStack.vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  publiclyAccessible: false,
  storageEncrypted: true,
  // ...
});

// database-stack.ts — VPC-wide CIDR ingress (overly permissive)
this.dbInstance.connections.securityGroups.forEach(function (securityGroup) {
  securityGroup.addIngressRule(
    ec2.Peer.ipv4(vpcStack.vpcCidrString), // Entire VPC CIDR
    ec2.Port.tcp(5432),
    "Allow PostgreSQL traffic from VPC",
  );
});
```

### 2.3 NAT Gateway Resilience

**Current Configuration:**
- **NAT Gateway count:** 1 (hardcoded `natGateways: 1`)
- **AZ placement:** Single AZ (CDK places the NAT in the first AZ's public subnet)
- **No `isProd` conditional:** The value is not configurable between dev/prod environments

**Services that lose internet connectivity if the NAT Gateway fails:**

All Lambda functions in `PRIVATE_WITH_EGRESS` subnets lose outbound internet access:

| Lambda Function | External Dependencies Lost | Impact |
|----------------|---------------------------|--------|
| adminLambdaAuthorizer | Secrets Manager (if no VPC endpoint in that subnet), Cognito token validation | Auth failures |
| studentLambdaAuthorizer | Same as above | Auth failures |
| instructorLambdaAuthorizer | Same as above | Auth failures |
| WsAuthorizer | Same as above | WebSocket auth failures |
| studentFunction | EventBridge, SSM Parameter Store | Notifications fail, config read fail |
| adminFunction | Cognito AdminAPI, SSM Parameter Store | User management fails |
| instructorFunction | EventBridge, SSM Parameter Store | Notifications fail |
| TextGenLambdaDockerFunction | **Amazon Bedrock API** | AI chat completely unavailable |
| PlaygroundTextGenLambdaDockerFunction | **Amazon Bedrock API** | Playground unavailable |
| CaseLambdaDockerFunction | **Amazon Bedrock API**, SSM | Case generation unavailable |
| AssessProgressFunction | **Amazon Bedrock API** | Progress assessment fails |
| audioToTextFunc | **Amazon Transcribe API** | Audio transcription unavailable |
| SummaryGenerationFunction | **Amazon Bedrock API** | Summary generation fails |
| addStudentOnSignUp | Secrets Manager (via NAT if not endpoint) | User registration may fail |

**Recovery Behavior:**
- NAT Gateway failure in a single AZ is typically auto-recovered by AWS within minutes
- However, during the outage window, **all AI features are completely unavailable** as Bedrock has no VPC endpoint provisioned
- The VPC endpoints for Secrets Manager and RDS (in isolated subnets) provide partial resilience for database operations
- Private-with-egress subnet Lambdas do NOT benefit from the VPC endpoints placed in isolated subnets

**Cross-References:** CDK-H4, WA-H2 (both Open in REMEDIATION-STATUS.md)

### 2.4 VPC Endpoints

**New VPC Path — Currently Provisioned:**

| Endpoint | Service | Type | Subnet Placement | Private DNS | Assessment |
|----------|---------|------|-----------------|-------------|------------|
| Secrets Manager Endpoint | `secretsmanager` | Interface | PRIVATE_ISOLATED | Yes (default) | ✅ Correct — serves RDS Proxy secret retrieval |
| RDS Endpoint | `rds` | Interface | PRIVATE_ISOLATED | Yes (default) | ✅ Correct — serves RDS API operations |

**Control Tower Path — Currently Provisioned:**

| Endpoint | Service | Type | Subnet Placement | Private DNS | Assessment |
|----------|---------|------|-----------------|-------------|------------|
| SSM Endpoint | `ssm` | Interface | PRIVATE_ISOLATED | No | ⚠️ Limited value — Lambda functions are in PRIVATE_WITH_EGRESS, not ISOLATED |
| Secrets Manager Endpoint | `secretsmanager` | Interface | PRIVATE_ISOLATED | No | ⚠️ Same concern — most consumers are in private-with-egress subnets |
| RDS Endpoint | `rds` | Interface | PRIVATE_ISOLATED | No | ✅ Correct — RDS is in isolated subnets |

**Missing VPC Endpoints — Assessment:**

| Service | Current Access Path | Traffic Volume | Recommendation | Justification |
|---------|-------------------|---------------|----------------|---------------|
| Amazon Bedrock (Runtime) | NAT Gateway → Internet | High (every AI request) | **Recommended** | Eliminates NAT dependency for core AI features; reduces NAT SPOF blast radius |
| Amazon S3 (Gateway) | NAT Gateway → Internet | Medium (audio uploads, pre-signed URLs) | **Recommended** | Gateway endpoints are free; eliminates unnecessary NAT traversal |
| CloudWatch Logs | NAT Gateway → Internet | High (all Lambda logging) | **Recommended** | Reduces NAT bandwidth consumption; improves logging reliability |
| DynamoDB | NAT Gateway → Internet | Medium (chat history, connections, notifications) | **Recommended** | Gateway endpoint is free; reduces NAT load |
| Amazon Transcribe | NAT Gateway → Internet | Low-Medium (audio processing) | Deferred | Lower priority; interface endpoint has per-hour cost |
| EventBridge | NAT Gateway → Internet | Low (notification events) | Deferred | Low volume; cost may not justify |
| SES | NAT Gateway → Internet | Low (email sending) | Deferred | Minimal traffic volume |
| SSM Parameter Store | NAT Gateway → Internet | Low (config reads) | Consider | Low cost interface endpoint; reduces NAT dependency for config |

### 2.5 Public Subnet Resources

**Resources identified in public subnets:**

| Resource | Subnet | Rationale |
|----------|--------|-----------|
| NAT Gateway | Public (1 AZ) | **Required** — NAT Gateways must reside in a public subnet with an Internet Gateway route to provide outbound internet for private subnets. This is architecturally correct. |
| Elastic IP (for NAT) | Public (1 AZ) | **Required** — EIP is attached to the NAT Gateway for a stable outbound IP address. |

**Assessment:** No application-tier resources (Lambda, RDS, compute) are deployed in public subnets. Only infrastructure networking components (NAT Gateway + EIP) occupy public subnets, which is the correct architecture pattern. The public subnet exists solely to provide the internet gateway path for the NAT Gateway.

### 2.6 Control Tower Path Assessment

The Control Tower path (`existingVpcId !== ""`) has a significant isolation concern:

**Finding: Shared Subnet IDs Between Private and Isolated Tiers**

```typescript
// vpc-stack.ts — Control Tower path
privateSubnetIds: [
  Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`),
  Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
  Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
],
// ...
isolatedSubnetIds: [
  Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`),  // SAME IDs!
  Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
  Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
],
```

**Issues Identified:**

1. **Subnet reuse between tiers:** The same subnet IDs are used for both `privateSubnetIds` and `isolatedSubnetIds`. This means the CDK logical separation between "private-with-egress" and "private-isolated" does not translate to actual network isolation. The RDS instance, which should be in a truly isolated subnet with no NAT route, is placed in the same subnet as Lambda functions that have NAT Gateway routes.

2. **NAT routes added to "isolated" subnets:** The code adds `0.0.0.0/0 → NAT Gateway` routes to all three private subnet route tables. Since isolated subnets share the same IDs, the RDS subnet route table also gets a NAT route — violating the isolation principle.

3. **Single-AZ public subnet:** In the Control Tower path, the public subnet (and thus NAT Gateway) is created in only the first AZ (`availabilityZone: this.vpc.availabilityZones[0]`). Three private subnets span 3 AZs but only one has a local NAT path.

4. **Private DNS disabled on VPC endpoints:** All VPC endpoints in the Control Tower path use `privateDnsEnabled: false`, meaning consumers must use the endpoint-specific DNS names rather than standard AWS service URLs. This requires explicit endpoint URL configuration in Lambda environment variables, which is not currently implemented.

**Security Group Assessment (Control Tower path):**
- When `privateSubnetsCidrStrings` are provided, the RDS security group adds ingress rules for each individual subnet CIDR range on port 5432, in addition to the VPC-wide CIDR rule
- The VPC-wide CIDR rule makes the per-subnet rules redundant
- No evidence of `0.0.0.0/0` inbound rules on the RDS security group — access is restricted to VPC CIDR

### 2.7 Security Group Rules per Subnet Tier

**Database Tier (PRIVATE_ISOLATED):**

| Direction | Source/Destination | Protocol | Port | Rule | Assessment |
|-----------|-------------------|----------|------|------|------------|
| Ingress | VPC CIDR (10.0.0.0/16 or imported) | TCP | 5432 | Allow PostgreSQL from VPC | ⚠️ Overly permissive — any VPC resource can connect |
| Ingress | Private subnet CIDRs (Control Tower only) | TCP | 5432 | Allow from private subnets | Redundant when VPC-wide rule exists |
| Egress | 0.0.0.0/0 | All | All | Default CDK egress | Standard — allows responses |

**Application Tier (PRIVATE_WITH_EGRESS) — Lambda Functions:**

Lambda functions in this tier use the **RDS security group** (`db.dbInstance.connections.securityGroups[0]`), which means:
- They inherit the RDS inbound rules (allowing other VPC resources to connect to them on port 5432 — irrelevant for Lambda but unnecessarily broad)
- Their outbound traffic is unrestricted (default CDK egress allows all)
- No dedicated Lambda security group exists to enforce least-privilege egress

**Assessment of 0.0.0.0/0 inbound:**
- ✅ No security group permits `0.0.0.0/0` inbound to the database tier
- ✅ No security group permits `0.0.0.0/0` inbound to the application (Lambda) tier
- ⚠️ The VPC-wide CIDR inbound rule on the RDS security group is overly broad but not internet-facing
- ⚠️ Lambda functions sharing the RDS security group have no egress restrictions (default allows all outbound)

### Findings

| ID | Title | Severity | Effort | Status |
|----|-------|----------|--------|--------|
| NW-H1 | Single NAT Gateway creates availability zone single point of failure | High | Low | Open |
| NW-H2 | Control Tower path uses same subnet IDs for private and isolated tiers, breaking network isolation | High | Medium | Open |
| NW-M1 | Missing VPC endpoints for high-traffic services (Bedrock, S3, CloudWatch, DynamoDB) increases NAT dependency and cost | Medium | Medium | New |
| NW-M2 | VPC endpoints placed in PRIVATE_ISOLATED subnets are not accessible from PRIVATE_WITH_EGRESS Lambda functions | Medium | Low | New |
| NW-M3 | Control Tower path adds NAT routes to "isolated" subnet route tables, violating isolation for RDS | Medium | Medium | Open |
| NW-L1 | Private DNS disabled on Control Tower VPC endpoints requires explicit endpoint URL configuration not currently implemented | Low | Low | New |

---

#### NW-H1: Single NAT Gateway creates availability zone single point of failure

- **Severity:** High
- **Section:** VPC Architecture Assessment
- **Current State:** `natGateways: 1` hardcoded in `vpc-stack.ts` line 139. No environment-conditional logic differentiates dev from prod.
- **Code Evidence:**
  ```typescript
  natGateways: 1,
  maxAzs: 2,
  ```
- **Gap:** With 2 AZs but only 1 NAT Gateway, an AZ failure affecting the NAT Gateway causes all private-subnet Lambda functions to lose outbound internet connectivity. No VPC endpoints exist for Bedrock, Transcribe, or EventBridge to provide fallback paths.
- **Risk:** Complete loss of AI functionality (chat, summaries, case generation, transcription, progress assessment) during an AZ failure. Authorizer functions may also fail if Secrets Manager endpoint is not reachable. Estimated blast radius: 13+ Lambda functions serving all user-facing features.
- **Recommendation:** Set `natGateways: 2` for production deployments (one per AZ). Use CDK context `isProd` conditional:
  ```typescript
  natGateways: isProd ? 2 : 1,
  ```
  Additional cost: ~$32/month for the second NAT Gateway.
- **Effort:** Low
- **Cross-References:** CDK-H4, WA-H2
- **Status:** Open

---

#### NW-H2: Control Tower path uses same subnet IDs for private and isolated tiers

- **Severity:** High
- **Section:** VPC Architecture Assessment
- **Current State:** `vpc-stack.ts` lines 38-60 import the same three Control Tower subnet IDs for both `privateSubnetIds` and `isolatedSubnetIds`.
- **Code Evidence:**
  ```typescript
  privateSubnetIds: [
    Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`),
    Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
    Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
  ],
  isolatedSubnetIds: [
    Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`), // Same!
    Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
    Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
  ],
  ```
- **Gap:** CDK's subnet type differentiation is purely logical when the same physical subnets are used. The database is deployed in what CDK considers "isolated" subnets, but these are the same physical subnets as the "private" subnets that have NAT Gateway routes added (lines 99-115). This eliminates the network-level isolation between application and database tiers.
- **Risk:** The RDS instance resides in a subnet with a route to the internet (via NAT). While `publiclyAccessible: false` prevents inbound internet connections, the principle of defense-in-depth requires the database tier to have no outbound internet path. A compromised RDS instance could theoretically exfiltrate data via the NAT route.
- **Recommendation:** In the Control Tower path, either:
  1. Import separate subnet IDs for truly isolated subnets (if available in the Control Tower stack set), OR
  2. Create new isolated subnets within the existing VPC specifically for RDS, without NAT routes, OR
  3. Document this as an accepted risk if the Control Tower environment does not provide separate isolated subnets
- **Effort:** Medium
- **Cross-References:** —
- **Status:** Open

---

#### NW-M1: Missing VPC endpoints for high-traffic services

- **Severity:** Medium
- **Section:** VPC Architecture Assessment
- **Current State:** Only Secrets Manager and RDS interface endpoints are provisioned. Bedrock, S3, CloudWatch Logs, and DynamoDB traffic all traverses the NAT Gateway.
- **Code Evidence:**
  ```typescript
  // vpc-stack.ts — New VPC path (only 2 endpoints)
  this.vpc.addInterfaceEndpoint(`${id}-Secrets Manager Endpoint`, { ... });
  this.vpc.addInterfaceEndpoint(`${id}-RDS Endpoint`, { ... });
  // No Bedrock, S3, CloudWatch, or DynamoDB endpoints
  ```
- **Gap:** High-volume services (every Bedrock AI call, every CloudWatch log write, every DynamoDB read) route through the single NAT Gateway unnecessarily, increasing cost, adding latency, and expanding the NAT SPOF blast radius.
- **Risk:** Increased NAT Gateway data processing charges (~$0.045/GB), added latency on AI requests, and expanded impact of NW-H1 (NAT failure affects more services than necessary). S3 Gateway endpoints are free; their absence is a clear optimization miss.
- **Recommendation:** Add VPC endpoints in priority order:
  1. S3 Gateway endpoint (free, immediate benefit)
  2. DynamoDB Gateway endpoint (free, supports chat history, connections, notifications tables)
  3. Bedrock Runtime interface endpoint (eliminates NAT dependency for all AI features)
  4. CloudWatch Logs interface endpoint (reduces NAT bandwidth for logging)
- **Effort:** Medium
- **Cross-References:** —
- **Status:** New

---

#### NW-M2: VPC endpoints in PRIVATE_ISOLATED not accessible from PRIVATE_WITH_EGRESS Lambdas

- **Severity:** Medium
- **Section:** VPC Architecture Assessment
- **Current State:** VPC endpoints for Secrets Manager and RDS are placed in `PRIVATE_ISOLATED` subnets. Lambda functions that need Secrets Manager access are deployed in `PRIVATE_WITH_EGRESS` subnets.
- **Code Evidence:**
  ```typescript
  // Endpoints in isolated subnets
  this.vpc.addInterfaceEndpoint(`${id}-Secrets Manager Endpoint`, {
    service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  });
  
  // Lambda functions in private-with-egress subnets
  vpc: vpcStack.vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  ```
- **Gap:** Interface VPC endpoints placed in isolated subnets create ENIs only in those subnets. Lambda functions in private-with-egress subnets can still reach Secrets Manager via the endpoint (if private DNS is enabled, the DNS resolution works VPC-wide), but the traffic crosses subnet boundaries. For the New VPC path, private DNS is enabled by default so this works correctly. The concern is primarily architectural — endpoint placement should align with primary consumers.
- **Risk:** Low immediate risk (private DNS resolves correctly VPC-wide in the new VPC path). However, for the Control Tower path where `privateDnsEnabled: false`, Lambda functions would need explicit endpoint URLs to use the VPC endpoint instead of NAT.
- **Recommendation:** Place VPC endpoints in `PRIVATE_WITH_EGRESS` subnets where primary consumers (Lambda functions) reside, or use `subnets: { subnetType: undefined }` to place in all subnets.
- **Effort:** Low
- **Cross-References:** —
- **Status:** New

---

#### NW-M3: Control Tower path adds NAT routes to isolated subnet route tables

- **Severity:** Medium
- **Section:** VPC Architecture Assessment
- **Current State:** In the Control Tower path, NAT Gateway routes (`0.0.0.0/0 → NAT`) are added to all three private subnet route tables. Since isolated subnets share the same IDs and route tables, the RDS subnet gains internet access.
- **Code Evidence:**
  ```typescript
  // vpc-stack.ts lines 99-115 — Routes added to all private subnets
  new ec2.CfnRoute(this, `${latPrefix}PrivateSubnetRoute1`, {
    routeTableId: this.vpc.privateSubnets[0].routeTable.routeTableId,
    destinationCidrBlock: "0.0.0.0/0",
    natGatewayId: natGateway.ref,
  });
  // ... repeated for subnets 2 and 3
  ```
- **Gap:** The isolated subnet route tables should have NO route to 0.0.0.0/0. Since the same subnets are used for both private and isolated tiers (NW-H2), adding NAT routes effectively gives the database tier outbound internet access.
- **Risk:** Violates network isolation principle for the database tier. A compromised database could reach the internet via NAT for data exfiltration, though this requires the attacker to first compromise the RDS instance (which has no direct internet exposure).
- **Recommendation:** This is a symptom of NW-H2. If separate isolated subnets are created, ensure their route tables have no 0.0.0.0/0 entry.
- **Effort:** Medium (depends on NW-H2 resolution)
- **Cross-References:** NW-H2
- **Status:** Open

---

#### NW-L1: Private DNS disabled on Control Tower VPC endpoints

- **Severity:** Low
- **Section:** VPC Architecture Assessment
- **Current State:** All VPC endpoints in the Control Tower path use `privateDnsEnabled: false`.
- **Code Evidence:**
  ```typescript
  this.vpc.addInterfaceEndpoint("SSM Endpoint", {
    service: ec2.InterfaceVpcEndpointAwsService.SSM,
    subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    privateDnsEnabled: false, // Disable private DNS to avoid conflicts
  });
  ```
- **Gap:** Without private DNS, Lambda functions using standard AWS SDK service URLs (e.g., `secretsmanager.{region}.amazonaws.com`) will route through NAT instead of the VPC endpoint. The endpoints exist but are not automatically used unless code explicitly references the endpoint DNS name.
- **Risk:** VPC endpoints are provisioned and incurring cost but may not be utilized by Lambda functions. Traffic continues through NAT, reducing the intended benefit of the endpoints. The comment says "avoid conflicts" suggesting a DNS resolution issue in the existing VPC.
- **Recommendation:** Either enable private DNS (requires VPC DNS hostnames and DNS support enabled) or configure Lambda environment variables with explicit VPC endpoint URLs for each service. Verify the "conflicts" rationale is still valid.
- **Effort:** Low
- **Cross-References:** —
- **Status:** New

---

## 3. Security Group Assessment

> *Requirement 2: Document Security Group Configuration Assessment*

This section assesses security group rules for RDS, RDS Proxy, and Lambda functions, evaluating least-privilege enforcement at the network layer.

### 3.1 RDS/RDS Proxy Security Group Rules

The RDS instance and RDS Proxy share the same security group (`Security_Group_RDS`), created automatically by CDK via `this.dbInstance.connections.securityGroups[0]`. The RDS Proxy is explicitly configured with `securityGroups: this.dbInstance.connections.securityGroups` in `database-stack.ts` (line ~173).

**Ingress Rules:**

| Rule | Direction | Source/Dest | Protocol | Port | Purpose |
|------|-----------|-------------|----------|------|---------|
| 1 | Ingress | VPC CIDR (`10.0.0.0/16` or Control Tower CIDR) | TCP | 5432 | Allow PostgreSQL from entire VPC |
| 2 | Ingress | Private subnet CIDRs (Control Tower path only) | TCP | 5432 | Allow PostgreSQL from private subnets |
| 3 | Ingress | Self-referencing (Security_Group_RDS) | TCP | 5432 | Allow Lambdas sharing this SG to connect |

**Code evidence** (`database-stack.ts`, lines 141–156):
```typescript
// Rule 1: Always applied — VPC-wide CIDR ingress
this.dbInstance.connections.securityGroups.forEach(
  function (securityGroup) {
    securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpcStack.vpcCidrString), // e.g., "10.0.0.0/16"
      ec2.Port.tcp(5432),
      "Allow PostgreSQL traffic from VPC",
    );
  },
);

// Rule 2: Only applied in existing VPC (Control Tower) path
if (vpcStack.privateSubnetsCidrStrings && vpcStack.privateSubnetsCidrStrings.length > 0) {
  vpcStack.privateSubnetsCidrStrings.forEach((cidr) => {
    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(cidr),
      ec2.Port.tcp(5432),
      `Allow PostgreSQL traffic from private subnet CIDR range ${cidr}`,
    );
  });
}
```

**Egress Rules:**

| Rule | Direction | Source/Dest | Protocol | Port | Purpose |
|------|-----------|-------------|----------|------|---------|
| Default | Egress | `0.0.0.0/0` | All | All | CDK default — allow all outbound |

**RDS Proxy Configuration:**
- `requireTLS: true` — enforces TLS between Lambda and RDS Proxy
- Uses the same security groups as the RDS instance

### 3.2 VPC-Wide CIDR Ingress Assessment

**Assessment: VPC-wide CIDR ingress violates least-privilege.**

The rule `ec2.Peer.ipv4(vpcStack.vpcCidrString)` on port 5432 permits **any resource within the VPC** to connect to RDS/RDS Proxy, including:

- Resources in public subnets (NAT Gateway subnet)
- VPC interface endpoint ENIs
- Any future EC2 instances or containers deployed in the VPC
- Lambda functions that do NOT require database access (e.g., `generatePreSignedURL` if it were VPC-connected)
- CDK auto-created security group ENIs

**Resources that actually require port 5432 access:**
1. Lambda Authorizers (admin, student, instructor, WebSocket) — 4 functions
2. REST API handlers (admin, student, instructor) — 3 functions
3. Cognito post-confirmation trigger (`addStudentOnSignUp`) — 1 function
4. Python AI functions (text_generation, summary_generation, case_generation, assess_progress, audioToText) — 5 functions
5. Playground generation — 1 function (has RDS_PROXY_ENDPOINT env var, but no `psycopg.connect()` call in code)

**Total legitimate database clients:** 13–14 Lambda functions

**VPC resources that do NOT need port 5432 and can currently reach it:**
- Public subnet resources (NAT Gateway ENI)
- VPC endpoint ENIs (SSM, Secrets Manager, RDS endpoints in isolated subnets)
- WebSocket functions (`wsConnect`, `wsDisconnect`, `wsDefault`) — NOT in VPC
- Notification service Lambda — NOT in VPC
- `generatePreSignedURL` — NOT in VPC
- Any future compute resources added to the VPC

When the Control Tower path is used, the private subnet CIDR rules are **redundant** because the VPC-wide CIDR rule already encompasses them.

### 3.3 Security-Group-Reference Recommendation

**Recommendation: Replace CIDR-based rules with security-group-reference-based rules.**

Current architecture uses a dual-pattern approach:
- Lambda authorizers and WebSocket authorizer: explicitly assigned `db.dbInstance.connections.securityGroups[0]`
- Other VPC Lambdas (handlers, AI functions): **no explicit securityGroups** — CDK auto-creates a new security group per Lambda

Since CDK creates unique security groups for Lambdas without explicit SG assignment, the only way these Lambdas currently reach the database is via the **VPC-wide CIDR rule** on the RDS security group.

**Recommended architecture:**

```typescript
// 1. Create a shared "database-client" security group in database-stack.ts
const dbClientSecurityGroup = new ec2.SecurityGroup(this, 'DbClientSG', {
  vpc: vpcStack.vpc,
  description: 'Shared SG for Lambda functions requiring database access',
  allowAllOutbound: false, // Enforce least-privilege egress
});

// 2. Allow only the client SG to reach RDS on port 5432
this.dbInstance.connections.allowFrom(
  dbClientSecurityGroup,
  ec2.Port.tcp(5432),
  'Allow database access from authorized Lambda functions only'
);

// 3. Remove the VPC-wide CIDR rule entirely
// DELETE: securityGroup.addIngressRule(ec2.Peer.ipv4(vpcStack.vpcCidrString), ...)

// 4. Assign dbClientSecurityGroup to all Lambdas needing database access
// In api-stack.ts:
securityGroups: [dbClientSecurityGroup]
```

**Benefits:**
- Only functions explicitly assigned the `dbClientSecurityGroup` can reach the database
- Adding new VPC resources does NOT automatically grant them database access
- Audit trail is clear — security group membership = database access authorization
- Compatible with both new VPC and Control Tower paths

### 3.4 Lambda Functions Sharing RDS Security Group

Functions **explicitly** assigned `db.dbInstance.connections.securityGroups[0]`:

| Lambda Function | RDS SG Attached | DB Dependency Evidence | Assessment |
|-----------------|-----------------|------------------------|------------|
| `adminLambdaAuthorizer` | ✅ Explicit | `initializeConnection.js` → `postgres()` to RDS Proxy; queries `users` table | ✅ Justified |
| `studentLambdaAuthorizer` | ✅ Explicit | Same authorization code; queries `users` table by `idp_id` | ✅ Justified |
| `instructorLambdaAuthorizer` | ✅ Explicit | Same authorization code; queries `users` table by `idp_id` | ✅ Justified |
| `WsAuthorizer` | ✅ Explicit | `wsAuthorizer.js` → `initializeConnection()` → queries `users` table | ✅ Justified |

Functions **VPC-connected without explicit SG** (CDK auto-creates security group; relies on VPC CIDR rule for DB access):

| Lambda Function | RDS SG Attached | DB Dependency Evidence | Assessment |
|-----------------|-----------------|------------------------|------------|
| `studentFunction` | ❌ CDK auto-SG | `initializeConnection.js` + env `RDS_PROXY_ENDPOINT` → executes SQL queries | ✅ Justified — needs DB |
| `adminFunction` | ❌ CDK auto-SG | `initializeConnection.js` + env `RDS_PROXY_ENDPOINT` → executes SQL queries | ✅ Justified — needs DB |
| `instructorFunction` | ❌ CDK auto-SG | `initializeConnection.js` + env `RDS_PROXY_ENDPOINT` → executes SQL queries | ✅ Justified — needs DB |
| `addStudentOnSignUp` | ❌ CDK auto-SG | `initializeConnection.js` → `INSERT INTO users` / `UPDATE users` | ✅ Justified — needs DB |
| `TextGenLambdaDockerFunction` | ❌ CDK auto-SG | `psycopg.connect()` with `RDS_PROXY_ENDPOINT` | ✅ Justified — needs DB |
| `SummaryGenerationFunction` | ❌ CDK auto-SG | `psycopg.connect()` with `RDS_PROXY_ENDPOINT` | ✅ Justified — needs DB |
| `CaseLambdaDockerFunction` | ❌ CDK auto-SG | `psycopg.connect()` with `RDS_PROXY_ENDPOINT` | ✅ Justified — needs DB |
| `AssessProgressFunction` | ❌ CDK auto-SG | `psycopg.connect()` with `RDS_PROXY_ENDPOINT` | ✅ Justified — needs DB |
| `audioToTextFunc` | ❌ CDK auto-SG | `psycopg.connect()` with `RDS_PROXY_ENDPOINT` | ✅ Justified — needs DB |
| `PlaygroundTextGenLambdaDockerFunction` | ❌ CDK auto-SG | Env `RDS_PROXY_ENDPOINT` set; comment in code: "maybe not needed"; **no `psycopg.connect()` call found** | ⚠️ Questionable — see §3.5 |

### 3.5 Unnecessary Database Connectivity

**Finding: `PlaygroundTextGenLambdaDockerFunction` has database connectivity without evidence of database usage.**

**Evidence:**
- **CDK config** (`api-stack.ts`, ~line 1812): VPC-connected with `vpc: vpcStack.vpc`
- **Environment variables set:** `SM_DB_CREDENTIALS`, `RDS_PROXY_ENDPOINT`
- **Code comment** in `playground_generation/src/main.py` (line 16): `# RDS_PROXY_ENDPOINT is availble but maybe not needed if we don't connect to Postgres for cases`
- **Code analysis:** No `psycopg.connect()` or database connection call found in the playground generation source. The function uses DynamoDB (`Playground-Table`) for conversation state and Bedrock for LLM invocation.

**Assessment:** The Playground generation function is placed in the VPC (required for Bedrock access via NAT Gateway) but does NOT establish database connections. It has `SM_DB_CREDENTIALS` and `RDS_PROXY_ENDPOINT` environment variables configured as apparent copy-paste from other AI Lambdas, but the code does not use them for database connections.

**Risk:** While the function doesn't actively connect to the database, its VPC placement means the VPC-wide CIDR rule grants it network-level access to port 5432 on RDS/RDS Proxy. If the function were compromised (e.g., via a supply chain attack on a Python dependency), an attacker could attempt database connections using the credentials available in Secrets Manager.

**Note:** The WebSocket functions (`wsConnect`, `wsDisconnect`, `wsDefault`) and `NotificationService` Lambda are **NOT** VPC-connected and therefore do not have database network access regardless of security group rules. The `generatePreSignedURL` function is also NOT VPC-connected. These are correctly configured.

### 3.6 Lambda Egress Rules

**Current State:**

All VPC-connected Lambda functions use CDK-default egress rules:

| Function Category | Egress Rule | Assessment |
|-------------------|-------------|------------|
| Authorizers (4 functions) | All traffic to `0.0.0.0/0` (CDK default) | ⚠️ Overly permissive |
| REST API handlers (3 functions) | All traffic to `0.0.0.0/0` (CDK default) | ⚠️ Overly permissive |
| AI/ML functions (5 functions) | All traffic to `0.0.0.0/0` (CDK default) | ⚠️ Overly permissive |
| Cognito trigger (1 function) | All traffic to `0.0.0.0/0` (CDK default) | ⚠️ Overly permissive |

**Required egress destinations by function category:**

| Function Category | Required Destinations | Protocol/Port |
|-------------------|----------------------|---------------|
| Authorizers | RDS Proxy (port 5432), Secrets Manager endpoint (443), SSM endpoint (443) | TCP 5432, TCP 443 |
| REST handlers | RDS Proxy (port 5432), Secrets Manager (443), SSM (443), EventBridge (443) | TCP 5432, TCP 443 |
| AI/ML functions | RDS Proxy (port 5432), Secrets Manager (443), SSM (443), Bedrock (443 via NAT), DynamoDB (443 via NAT), WebSocket API endpoint (443 via NAT), EventBridge (443) | TCP 5432, TCP 443 |
| Cognito trigger | RDS Proxy (port 5432), Secrets Manager (443), SSM (443), Cognito IDP (443), DynamoDB (443) | TCP 5432, TCP 443 |

**Assessment:** CDK's default `allowAllOutbound: true` on security groups means all VPC Lambda functions can send traffic to any IP on any port. This is a defense-in-depth gap — if a Lambda function is compromised, the attacker has unrestricted outbound network access for data exfiltration or C2 communication.

**Practical considerations:** Restricting egress is a Medium-effort change because:
1. VPC endpoints provide fixed ENI IPs, but NAT-Gateway-routed destinations (Bedrock, Transcribe) have dynamic IPs
2. AWS service endpoints resolve to many IP ranges that change
3. A prefix list approach (`com.amazonaws.{region}.{service}`) or VPC endpoint strategy would be needed
4. Overly restrictive egress can break deployments if any service endpoint is missed

**Recommendation:** Implement egress restrictions in phases:
- **Phase 1 (Low effort):** Restrict authorizer Lambda egress to port 5432 (RDS Proxy) + port 443 (VPC endpoint CIDR prefixes) only, since authorizers have the most predictable traffic patterns
- **Phase 2 (Medium effort):** Add VPC endpoints for DynamoDB and EventBridge; restrict handler Lambdas to port 5432 + port 443 only
- **Phase 3 (High effort):** Evaluate prefix lists or AWS Network Firewall for controlling NAT-routed egress for AI functions

### Findings

| ID | Title | Severity | Effort | Status |
|----|-------|----------|--------|--------|
| NW-H1 | VPC-wide CIDR ingress on RDS security group violates least-privilege | High | Medium | Open |
| NW-M1 | Playground generation Lambda has unnecessary database network connectivity | Medium | Low | New |
| NW-M2 | All VPC Lambda functions have unrestricted egress (0.0.0.0/0) | Medium | Medium | New |
| NW-M3 | Inconsistent security group assignment pattern across Lambda functions | Medium | Medium | New |

---

#### NW-H1: VPC-wide CIDR ingress on RDS security group violates least-privilege

- **Severity:** High
- **Section:** 3. Security Group Assessment
- **Current State:** `database-stack.ts` adds `ec2.Peer.ipv4(vpcStack.vpcCidrString)` on port 5432 to the RDS security group, allowing any VPC resource to connect to the database. When the Control Tower path is active, additional private subnet CIDR rules are added but are redundant.
- **Gap:** Any resource within the VPC CIDR range has network-level access to the database, not just the 13–14 Lambda functions that legitimately require it. No network-layer segmentation distinguishes authorized from unauthorized database clients.
- **Risk:** If any VPC resource (current or future) is compromised, the attacker can attempt connections to RDS/RDS Proxy on port 5432. Combined with credentials from Secrets Manager (if the compromised function has `secretsmanager:GetSecretValue` permissions), this enables unauthorized database access. Attack surface grows with every new VPC resource.
- **Recommendation:** Create a shared `dbClientSecurityGroup` in `database-stack.ts`. Replace the VPC CIDR ingress rule with a security-group-reference rule allowing only `dbClientSecurityGroup` on port 5432. Assign `dbClientSecurityGroup` to all Lambda functions that demonstrably require database access (14 functions identified in §3.4). Remove the CIDR-based rules entirely.
- **Effort:** Medium (requires coordinated changes in `database-stack.ts` and `api-stack.ts`; testing needed to confirm all functions still connect)
- **Cross-References:** `RDS-H2` (code-review-rds.md) — same finding, status Open in REMEDIATION-STATUS.md
- **Status:** Open

---

#### NW-M1: Playground generation Lambda has unnecessary database network connectivity

- **Severity:** Medium
- **Section:** 3. Security Group Assessment
- **Current State:** `PlaygroundTextGenLambdaDockerFunction` is VPC-connected with `SM_DB_CREDENTIALS` and `RDS_PROXY_ENDPOINT` environment variables configured (`api-stack.ts`, ~line 1812). The source code (`playground_generation/src/main.py`) contains a comment `# RDS_PROXY_ENDPOINT is availble but maybe not needed if we don't connect to Postgres for cases` and no `psycopg.connect()` call is present.
- **Gap:** The function has network-level database access via VPC CIDR rule and credentials available via Secrets Manager, despite not using database connections. This provides an unnecessary attack surface.
- **Risk:** If the Playground generation function is compromised (supply chain attack, code injection via adversarial prompts reaching the LLM's tool-use layer), the attacker gains database network access and can retrieve credentials from Secrets Manager to access production data.
- **Recommendation:** (1) Remove `SM_DB_CREDENTIALS` and `RDS_PROXY_ENDPOINT` environment variables from the Playground function. (2) Remove `db.secretPathUser.grantRead(playgroundGenLambdaDockerFunc)` IAM permission. (3) When implementing NW-H1's security group reference pattern, do NOT assign `dbClientSecurityGroup` to this function.
- **Effort:** Low (configuration change only — remove env vars and IAM grant)
- **Cross-References:** None (new finding)
- **Status:** New

---

#### NW-M2: All VPC Lambda functions have unrestricted egress (0.0.0.0/0)

- **Severity:** Medium
- **Section:** 3. Security Group Assessment
- **Current State:** All VPC-connected Lambda functions use CDK's default `allowAllOutbound: true` security group egress configuration. No explicit egress restrictions are defined in `api-stack.ts` or `database-stack.ts` for any Lambda function.
- **Gap:** Lambda functions can send outbound traffic to any IP address on any port. Authorizer functions (which only need RDS Proxy and Secrets Manager) have the same unrestricted egress as AI functions (which legitimately need NAT-routed access to Bedrock and Transcribe).
- **Risk:** A compromised Lambda function can exfiltrate data to any external endpoint, establish C2 channels, or scan the internal network without restriction. This is a defense-in-depth gap — while IAM policies restrict API calls, network-level egress is unconstrained.
- **Recommendation:** Implement egress restrictions in phases starting with authorizer Lambdas (restrict to port 5432 + port 443 to VPC endpoint prefixes). Use `allowAllOutbound: false` and add explicit `addEgressRule()` calls. For AI functions requiring NAT-routed internet access, restrict to port 443 only (HTTPS).
- **Effort:** Medium (requires careful identification of all egress destinations per function; testing in staging; rollback plan)
- **Cross-References:** None (new finding; partially related to defense-in-depth theme in code-review-security.md)
- **Status:** New

---

#### NW-M3: Inconsistent security group assignment pattern across Lambda functions

- **Severity:** Medium
- **Section:** 3. Security Group Assessment
- **Current State:** Lambda authorizers and WsAuthorizer are explicitly assigned `db.dbInstance.connections.securityGroups[0]` (the RDS security group directly). REST API handlers, AI functions, and the Cognito trigger are VPC-connected without explicit security group assignment — CDK auto-creates individual security groups for each, and they rely on the VPC CIDR rule (NW-H1) for database connectivity.
- **Gap:** Two different security group patterns coexist: (1) explicit RDS SG assignment for authorizers, (2) implicit CDK-managed SGs for handlers. This creates confusion about which functions have database access and makes security auditing difficult. The explicit pattern (authorizers sharing the RDS SG directly) also means those functions inherit any future rule changes to the RDS security group.
- **Risk:** Security group sprawl and inconsistent patterns lead to:
  - Difficulty auditing database access — must check both SG membership and CIDR rules
  - Risk of accidentally granting database access to new resources via CIDR rule
  - Unintended privilege inheritance if RDS SG rules change
- **Recommendation:** Standardize on a single pattern: create a dedicated `dbClientSecurityGroup` (per NW-H1 recommendation) and assign it uniformly to all functions requiring database access. Stop sharing the RDS instance's own security group with Lambda functions. This separates "database server" rules from "database client" rules.
- **Effort:** Medium (same remediation as NW-H1; this finding documents the additional consistency concern)
- **Cross-References:** `RDS-H2` (code-review-rds.md, recommendation R3)
- **Status:** New

---

## 4. WAF CloudFront Assessment

> *Requirement 3: Document WAF CloudFront Configuration Assessment*

This section assesses the CloudFront-scoped WAF Web ACL protecting the Amplify frontend distribution, defined in `cdk/lib/waf-stack.ts`.

### 4.1 Current Rule Set

**Source:** `cdk/lib/waf-stack.ts` lines 24–67

The CloudFront WAF Web ACL (`scope: "CLOUDFRONT"`) uses a **default-allow** action and contains only 2 rules:

| Rule Name | Priority | Type | Action | Visibility Config |
|-----------|----------|------|--------|-------------------|
| `AWS-AWSManagedRulesCommonRuleSet` | 1 | Managed Rule Group | `overrideAction: { none: {} }` (uses rule group's native actions) | `sampledRequestsEnabled: true`, `cloudWatchMetricsEnabled: true`, metric: `AWS-AWSManagedRulesCommonRuleSet-CloudFront` |
| `LimitRequests1000` | 2 | Custom Rate-Based | `action: { block: {} }` | `sampledRequestsEnabled: true`, `cloudWatchMetricsEnabled: true`, metric: `LimitRequests1000-CloudFront` |

**Web ACL-level visibility config:**
- `sampledRequestsEnabled: true`
- `cloudWatchMetricsEnabled: true`
- Metric: `CloudFront-WAF`

**Observations:**
- The `AWSManagedRulesCommonRuleSet` is applied with `overrideAction: { none: {} }`, meaning all rules within the group execute with their default actions (a mix of Block and Count depending on the specific rule). This is the correct configuration — using `{ count: {} }` would disable all blocking within the group.
- The rate-based rule uses `aggregateKeyType: "IP"` with a hard block action (no CAPTCHA challenge alternative).
- The WAF is associated with the Amplify app via `CfnWebACLAssociation` using the `amplifyAppArn` prop.

### 4.2 Rate Limit Assessment

**Current configuration:** 1000 requests per 5-minute evaluation window per IP address, with a **block** action.

**Calibration analysis:**

| Factor | Assessment |
|--------|------------|
| **Threshold math** | 1000 req / 5 min = ~3.3 req/sec sustained per IP. For a frontend SPA, this includes all static asset requests, API calls, and page navigations. |
| **Expected legitimate usage** | A single active user session generates ~20–50 requests on page load (JS bundles, CSS, images, API calls), then ~5–15 API calls per minute during active interaction (chat, navigation). Peak burst: ~50 requests in a few seconds on page refresh. |
| **Shared-IP risk (university networks)** | **HIGH FALSE-POSITIVE RISK.** University networks, law school computer labs, and corporate VPNs route hundreds of students through a single egress IP. With 20+ concurrent users on one IP, legitimate traffic could reach 1000 requests in 5 minutes during class sessions (20 users × 50 requests/page load = 1000 immediately on class start). |
| **CloudFront caching mitigation** | Static assets served from CloudFront edge cache do NOT count against WAF rate limits (WAF evaluates origin requests). However, Amplify apps with dynamic content and API routes may have limited caching, reducing this mitigation. |
| **Block vs CAPTCHA** | The current **block** action returns a 403 with no recourse for the user. A CAPTCHA challenge would be more appropriate for rate-exceeded scenarios as it allows legitimate users to self-unblock while still deterring automated attacks. However, CAPTCHA requires AWS WAF Bot Control subscription for the CAPTCHA action type. |

**Verdict:** The 1000 req/5min threshold is reasonable for single-user scenarios but poses a significant false-positive risk for shared-IP academic environments — the platform's primary user base. The block action (vs CAPTCHA) compounds this risk by providing no self-remediation path.

### 4.3 Additional Managed Rule Groups

| Rule Group | Recommendation | Justification |
|------------|---------------|---------------|
| `AWSManagedRulesKnownBadInputsRuleSet` | **Recommend — Add** | Protects against Log4j/JNDI injection, known bad User-Agent strings, and request smuggling patterns. Low false-positive risk for legal content. Minimal cost overhead. This is a standard baseline rule group that complements CommonRuleSet. |
| `AWSManagedRulesBotControlRuleSet` | **Defer** | Provides advanced bot detection (browser fingerprinting, behavioral analysis). However, it carries significant cost (~$10/month + $1 per million requests inspected) and higher false-positive risk for headless browser testing and accessibility tools. Defer until bot traffic becomes a documented problem via WAF metrics. The existing rate limiting provides basic bot mitigation. |
| `AWSManagedRulesAmazonIpReputationList` | **Recommend — Add** | Blocks requests from IPs identified by Amazon Threat Intelligence as participating in DDoS, botnets, or other malicious activities. Very low false-positive rate (reputation lists are conservative). No additional cost beyond standard WAF pricing. Provides immediate value against known-bad infrastructure. |

### 4.4 Geo-Restriction Assessment

**Current state:** No geo-restriction rules are configured in the CloudFront WAF. The WAF accepts traffic from all geographic regions.

**Risk assessment:**

| Factor | Analysis |
|--------|----------|
| **Platform audience** | LAIGO serves Canadian legal education users (law schools, legal clinics). The expected legitimate user base is predominantly Canadian. |
| **Attack surface** | Without geo-restriction, the platform is exposed to volumetric attacks and credential stuffing from global botnets. A significant percentage of automated attack traffic originates from regions outside North America. |
| **False-positive risk** | Low. Canadian law students and instructors are overwhelmingly accessing from Canadian IPs. Edge cases: students traveling abroad, VPN usage. These can be addressed via exception lists or broader regional allowlists (e.g., allow CA + US to cover cross-border travel). |
| **Regulatory alignment** | Canadian legal data handling (attorney-client privilege, provincial privacy laws) may benefit from restricting access to Canadian jurisdictions as an additional data sovereignty control. |

**Recommendation:** Add a geo-restriction rule allowing traffic only from Canada (`CA`) and the United States (`US`) at a minimum, with the option to expand if user travel patterns require it. Implement as a separate WAF rule with priority 0 (evaluated first) to drop traffic before it reaches more expensive rule evaluations. Consider CloudFront's built-in geographic restriction feature as an alternative to a WAF geo-match rule.

### 4.5 WAF Logging Configuration

**Current state:** No WAF logging is configured in `cdk/lib/waf-stack.ts`.

The CDK stack does not include:
- `CfnLoggingConfiguration` resource
- Any S3 bucket, CloudWatch Logs log group, or Kinesis Data Firehose delivery stream for WAF log output
- No log filter configuration

**Gap analysis:**

| Required Capability | Status | Assessment |
|--------------------|--------|------------|
| Full request URI captured | ❌ Not configured | Cannot investigate which URLs are targeted in attacks |
| Source IP captured | ❌ Not configured | Cannot identify attacking IPs for manual blocking or forensics |
| Rule match details | ❌ Not configured | Cannot determine which rules are triggering (useful for tuning false positives) |
| Action taken (allow/block/count) | ❌ Not configured | Cannot measure WAF effectiveness or identify rules in count-only mode |
| 90-day retention in queryable store | ❌ Not configured | No retention at all — complete blind spot for incident response |

**Impact:** Without WAF logging, the security team cannot:
1. Investigate security incidents involving the frontend
2. Tune WAF rules to reduce false positives (especially important for legal content triggering SQLi rules)
3. Identify attack patterns or targeted endpoints
4. Demonstrate compliance with security monitoring requirements
5. Correlate WAF events with application-level anomalies

### 4.6 Default-Allow Assessment

**Current state:** The WAF uses `defaultAction: { allow: {} }` with only two protective rules:
1. `AWSManagedRulesCommonRuleSet` — covers common web exploits (XSS, SQLi, path traversal, etc.)
2. `LimitRequests1000` — IP-based rate limiting

**Gap analysis — missing deny/protection rules:**

| Threat Category | Current Coverage | Gap |
|-----------------|-----------------|-----|
| Common web exploits (XSS, SQLi, LFI) | ✅ Covered by CommonRuleSet | — |
| Rate-based abuse (volumetric) | ✅ Covered by LimitRequests1000 | Block action with no CAPTCHA fallback |
| Known bad inputs (Log4j, JNDI, smuggling) | ❌ No coverage | No `KnownBadInputsRuleSet` |
| Malicious IP reputation | ❌ No coverage | No `AmazonIpReputationList` |
| Bot traffic | ⚠️ Basic (rate limiting only) | No bot detection/challenge |
| Geographic restriction | ❌ No coverage | All regions allowed |
| Oversized requests | ❌ No coverage | No size constraint rules |
| Known attack User-Agents | ❌ No coverage | Only covered if KnownBadInputs is added |

**Recommendation:** The current rule set provides minimum-viable protection but leaves significant gaps for a platform handling privileged legal content. The default-allow posture means that any request not matching the two rules passes through unimpeded. Add at minimum:
1. `AWSManagedRulesKnownBadInputsRuleSet` (priority 3)
2. `AWSManagedRulesAmazonIpReputationList` (priority 0, before other rules)
3. Geo-restriction rule for CA/US traffic only (priority 4)
4. Size constraint rule to prevent oversized requests to origin (priority 5)

### Findings

| ID | Title | Severity | Effort | Status |
|----|-------|----------|--------|--------|
| NW-H1 | No WAF logging configured on CloudFront WAF | High | Low | New |
| NW-H2 | No geo-restriction on CloudFront WAF for Canadian-only platform | High | Low | New |
| NW-M1 | Rate limit threshold false-positive risk for shared-IP university networks | Medium | Low | New |
| NW-M2 | Missing KnownBadInputs and IpReputation managed rule groups | Medium | Low | New |
| NW-M3 | Rate limit uses hard block instead of CAPTCHA challenge | Medium | Medium | New |
| NW-L1 | No Bot Control managed rule group (deferred recommendation) | Low | Medium | New |

---

### Finding Details

#### NW-H1: No WAF logging configured on CloudFront WAF

- **Severity:** High
- **Section:** WAF CloudFront Assessment
- **Current State:** `cdk/lib/waf-stack.ts` creates a `CfnWebACL` but does not define a `CfnLoggingConfiguration` resource. No log destination (S3, CloudWatch Logs, or Kinesis Firehose) is configured.
- **Gap:** Complete absence of WAF request logging means zero visibility into blocked/allowed requests, attack patterns, or false positives affecting legitimate users.
- **Risk:** During a security incident targeting the frontend, the team has no forensic data to identify attack vectors, affected users, or timeline. False positives blocking legitimate legal users (e.g., CommonRuleSet triggering on SQL-like legal terminology) cannot be detected or tuned without logs.
- **Recommendation:** Add a `CfnLoggingConfiguration` in `waf-stack.ts` directing logs to an S3 bucket with 90-day retention and Athena queryability. Use the naming prefix `aws-waf-logs-` (required by AWS). Enable CloudWatch Metrics for real-time alerting. Example:
  ```typescript
  new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
    resourceArn: webAcl.attrArn,
    logDestinationConfigs: [logBucket.bucketArn],
    loggingFilter: { /* include all for initial deployment */ }
  });
  ```
- **Effort:** Low (CDK configuration addition, no code change)
- **Cross-References:** WA-H1 (No CloudWatch Alarms defined anywhere)
- **Status:** New

#### NW-H2: No geo-restriction on CloudFront WAF for Canadian-only platform

- **Severity:** High
- **Section:** WAF CloudFront Assessment
- **Current State:** `cdk/lib/waf-stack.ts` contains no geo-match statement or country-based rule. All traffic from any geographic origin is evaluated equally.
- **Gap:** A Canadian legal education platform with no geographic access control exposes the application to global attack traffic and provides no jurisdictional data access boundary.
- **Risk:** (1) Increased attack surface from global botnets and automated scanners. (2) Potential regulatory concern — Canadian legal data handling practices benefit from demonstrating geographic access controls. (3) Users in unauthorized jurisdictions could access privileged legal educational content.
- **Recommendation:** Add a geo-match rule at priority 0 that blocks traffic from outside Canada and the United States:
  ```typescript
  {
    name: "GeoRestriction",
    priority: 0,
    action: { block: {} },
    statement: {
      notStatement: {
        statement: {
          geoMatchStatement: {
            countryCodes: ["CA", "US"],
          },
        },
      },
    },
    visibilityConfig: { /* ... */ },
  }
  ```
  Include US to accommodate cross-border travel. Consider adding a mechanism for exception requests (e.g., admin override IP list).
- **Effort:** Low (CDK configuration addition)
- **Cross-References:** — (New finding, not previously identified)
- **Status:** New

#### NW-M1: Rate limit threshold false-positive risk for shared-IP university networks

- **Severity:** Medium
- **Section:** WAF CloudFront Assessment
- **Current State:** `cdk/lib/waf-stack.ts` line 48–60 defines `LimitRequests1000` with `limit: 1000` and `aggregateKeyType: "IP"`. Action is `block`.
- **Gap:** 1000 requests per 5 minutes per IP is insufficient headroom for shared-IP environments (university campus networks, law school computer labs) where 20+ concurrent users share a single egress IP.
- **Risk:** During peak usage (e.g., a class session starting simultaneously), legitimate users on university networks will be blocked for 5 minutes with no self-remediation path. This directly impacts the platform's primary user base (law students and legal clinic workers).
- **Recommendation:** Either (a) increase the threshold to 2000–3000 for the CloudFront WAF (static assets are less security-sensitive than API calls, which have their own regional WAF rate limit), or (b) add a scope-down statement excluding known educational institution IP ranges, or (c) implement a CAPTCHA challenge action (requires Bot Control subscription) instead of a hard block. Option (a) is simplest and maintains protection against true volumetric attacks while accommodating shared-IP scenarios.
- **Effort:** Low (change `limit: 1000` to `limit: 2000` in CDK)
- **Cross-References:** — (New finding; API Gateway WAF has a separate 2000 req/5min limit)
- **Status:** New

#### NW-M2: Missing KnownBadInputs and IpReputation managed rule groups

- **Severity:** Medium
- **Section:** WAF CloudFront Assessment
- **Current State:** `cdk/lib/waf-stack.ts` only includes `AWSManagedRulesCommonRuleSet`. No other managed rule groups are configured.
- **Gap:** The WAF lacks protection against known bad input patterns (Log4j/JNDI injection, request smuggling) and traffic from IPs with known malicious reputation. These are standard baseline protections with minimal false-positive risk.
- **Risk:** Attackers using known exploit patterns (Log4Shell, path traversal via encoded sequences) or launching attacks from known-bad infrastructure (botnets, compromised hosting) are not blocked at the WAF layer. While CommonRuleSet covers some overlap, dedicated rule groups provide more comprehensive and current protection.
- **Recommendation:** Add both rule groups to `waf-stack.ts`:
  ```typescript
  {
    name: "AWS-AWSManagedRulesKnownBadInputsRuleSet",
    priority: 3,
    statement: {
      managedRuleGroupStatement: {
        vendorName: "AWS",
        name: "AWSManagedRulesKnownBadInputsRuleSet",
      },
    },
    overrideAction: { none: {} },
    visibilityConfig: { /* ... */ },
  },
  {
    name: "AWS-AWSManagedRulesAmazonIpReputationList",
    priority: 4,
    statement: {
      managedRuleGroupStatement: {
        vendorName: "AWS",
        name: "AWSManagedRulesAmazonIpReputationList",
      },
    },
    overrideAction: { none: {} },
    visibilityConfig: { /* ... */ },
  }
  ```
- **Effort:** Low (CDK configuration addition, no additional cost beyond standard WAF pricing)
- **Cross-References:** — (New finding)
- **Status:** New

#### NW-M3: Rate limit uses hard block instead of CAPTCHA challenge

- **Severity:** Medium
- **Section:** WAF CloudFront Assessment
- **Current State:** `LimitRequests1000` rule at line 50 uses `action: { block: {} }`.
- **Gap:** When a legitimate user (or shared-IP group) exceeds the rate limit, they receive an opaque 403 error with no path to self-remediation. This creates a poor user experience for legitimate users on shared networks.
- **Risk:** Legitimate users blocked during peak usage periods (class start times, assignment deadlines) will perceive the platform as unreliable. Support burden increases as users report "access denied" errors that are actually WAF rate-limit blocks.
- **Recommendation:** Replace `block` action with `captcha` action for rate-exceeded requests. This allows legitimate users to prove they are human while still blocking automated attacks. Note: CAPTCHA action requires the AWS WAF Bot Control feature (additional cost: ~$10/month). If cost is a concern, consider using `challenge` (silent JavaScript challenge, no user interaction required) as a middle ground:
  ```typescript
  action: { captcha: {} }  // or { challenge: {} } for silent verification
  ```
  If neither CAPTCHA nor challenge is feasible, increase the threshold (see NW-M1) and add a custom error response page explaining the rate limit to affected users.
- **Effort:** Medium (requires Bot Control subscription for CAPTCHA; CDK change itself is trivial)
- **Cross-References:** NW-M1 (related rate limit threshold concern)
- **Status:** New

#### NW-L1: No Bot Control managed rule group (deferred recommendation)

- **Severity:** Low
- **Section:** WAF CloudFront Assessment
- **Current State:** No `AWSManagedRulesBotControlRuleSet` is configured.
- **Gap:** Advanced bot detection (browser fingerprinting, behavioral analysis, known bot signatures) is not available. Only IP-based rate limiting provides basic bot mitigation.
- **Risk:** Sophisticated bots that stay under rate limits can scrape legal content, enumerate users, or probe for vulnerabilities. However, the current rate limiting + CommonRuleSet provides baseline protection, and the platform is not a high-value scraping target (requires authentication).
- **Recommendation:** Defer until WAF metrics (once logging is enabled per NW-H1) show evidence of bot traffic patterns. Re-evaluate in 90 days after WAF logging provides visibility. The additional cost (~$10/month + $1/million requests) is not justified without documented bot traffic.
- **Effort:** Medium (CDK addition is simple, but requires Bot Control subscription and tuning to avoid false positives)
- **Cross-References:** NW-H1 (logging needed first to assess bot traffic)
- **Status:** New

---

## 5. WAF API Gateway Assessment

> *Requirement 4: Document WAF API Gateway Configuration Assessment*

This section assesses the regional WAF Web ACL protecting the API Gateway REST API stage, defined inline in `cdk/lib/api-stack.ts`.

### 5.1 Current Rule Set

The API Gateway WAF Web ACL is defined inline in `api-stack.ts` (scope: `REGIONAL`) with a default-allow action. Three rules are configured:

| Rule Name | Priority | Action | Scope | Notes |
|-----------|----------|--------|-------|-------|
| AWS-AWSManagedRulesCommonRuleSet | 1 | `overrideAction: { none: {} }` (block mode — respects rule group actions) | All requests | OWASP Top 10 baseline protections |
| LimitRequests2000 | 2 | `action: { block: {} }` | Per-IP | Rate-based: 2000 req/5 min per IP |
| PerUserRateLimit | 3 | `action: { block: {} }` | Per-user (MD5 of Authorization header) | Rate-based: 200 req/5 min per authenticated user |

**Evidence** (`cdk/lib/api-stack.ts`):
```typescript
const waf = new wafv2.CfnWebACL(this, `${id}-waf`, {
  description: "WAF for API Gateway protection",
  scope: "REGIONAL",
  defaultAction: { allow: {} },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "DFO-firewall",
  },
  rules: [
    { name: "AWS-AWSManagedRulesCommonRuleSet", priority: 1, ... overrideAction: { none: {} } },
    { name: "LimitRequests2000", priority: 2, action: { block: {} }, ... limit: 2000, aggregateKeyType: "IP" },
    { name: "PerUserRateLimit", priority: 3, action: { block: {} }, ... limit: 200, aggregateKeyType: "CUSTOM_KEYS",
      customKeys: [{ header: { name: "Authorization", textTransformations: [{ type: "MD5" }] } }] },
  ],
});
```

The WAF is associated with the REST API stage via `CfnWebACLAssociation`:
```typescript
resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.api.restApiId}/stages/${this.api.deploymentStage.stageName}`
```

### 5.2 IP-Based Rate Limit Assessment

**Current Configuration:** 2000 requests per 5-minute evaluation window per IP, blocking action.

**Calibration Against Stage Throttle:**
- API Gateway stage throttle: 100 req/s sustained, 200 burst → theoretical max = 30,000 requests per 5 minutes per stage
- WAF IP rate limit: 2000 req/5 min → equivalent to ~6.7 req/s sustained per IP
- The WAF limit sits well below the stage throttle, meaning a single IP cannot exhaust stage capacity before being blocked

**Assessment:**
- The 2000/5min threshold is reasonable for a legal education platform with moderate expected concurrent users (~50–200 active)
- For shared-IP environments (university campus NAT, corporate proxies), 2000 requests across 5 minutes for all users behind one IP is adequate — a class of 30 students generating ~10 requests/minute each would consume 1,500 requests (75% of limit), leaving headroom
- However, during peak exam or assignment periods with heavy AI chat usage, shared-IP false positives become more likely
- The `block` action provides immediate protection but offers no CAPTCHA fallback or custom response to inform users why they are blocked

**Verdict:** Adequately calibrated for normal usage; marginal risk of false positives for shared-campus IPs during peak activity. Consider adding a custom block response body with a user-friendly message.

### 5.3 Per-User Rate Limit Assessment

**Current Configuration:** 200 requests per 5-minute evaluation window per authenticated user, blocking action.

**Role-Based Peak Activity Estimation:**

| Role | Peak Activity Pattern | Estimated Peak Requests/5 min | Headroom |
|------|----------------------|-------------------------------|----------|
| Advocate (Student) | Active AI chat session (rapid message exchanges) + notepad saves + case navigation | ~60–80 | 60–70% margin |
| Supervisor (Instructor) | Reviewing multiple cases, providing feedback, batch operations | ~40–60 | 70–80% margin |
| Admin | AI playground testing (rapid prompt iterations), user management, prompt configuration | ~100–150 | 25–50% margin |

**Assessment:**
- For advocates and supervisors, 200 req/5 min provides comfortable headroom
- For admins using the AI playground with rapid prompt testing (generate → review → modify → regenerate), 200 requests could be reached during intensive testing sessions
- The WebSocket API is NOT covered by this WAF, so streaming chat messages don't count against this limit — only REST API calls do
- The limit appropriately prevents automated tooling or scripts from abusing API endpoints

**Verdict:** Well-calibrated for typical usage. Admin playground testing is the edge case most likely to trigger the limit but is a low-probability scenario since admin testing is infrequent.

### 5.4 Per-User Rate Limit Implementation

**Implementation:** MD5 hash of the `Authorization` header value (JWT bearer token) used as the custom aggregation key.

```typescript
customKeys: [{
  header: {
    name: "Authorization",
    textTransformations: [{ priority: 0, type: "MD5" }],
  },
}]
```

**Collision Risk Assessment:**
- MD5 produces 128-bit hashes (2^128 possible values)
- Birthday paradox collision probability for `n` concurrent users: P ≈ n² / (2 × 2^128)
- At 1,000 concurrent users: P ≈ 10^6 / (2 × 3.4 × 10^38) ≈ 1.5 × 10^-33 — negligible
- **Verdict:** MD5 collision risk is astronomically low for this use case. MD5's cryptographic weaknesses (preimage attacks) are irrelevant here since the goal is unique aggregation, not security-sensitive hashing

**Token Refresh Bypass Assessment:**
- Cognito tokens expire every 30 minutes (`accessTokenValidity: cdk.Duration.minutes(30)`)
- When a token refreshes, the new JWT has a different signature → different MD5 hash → treated as a new "user" by WAF
- An attacker could theoretically force token refresh to reset their rate limit counter
- However, Cognito refresh tokens have their own rate limits, and rapid refresh attempts would be logged
- **Practical risk:** Low. The 5-minute WAF evaluation window and 30-minute token validity mean at most one mid-window reset per user. An attacker would get at most 400 requests per 5 minutes (2× the limit), which is still below the IP-based limit

**Unauthenticated Request Fallback:**
- If the `Authorization` header is missing (unauthenticated requests), the custom key has no value
- WAF behavior: requests without the specified header are NOT matched by the custom-key rule — they fall through to the IP-based rate limit only (2000/5 min)
- This means unauthenticated scanning/probing is controlled only by the IP rate limit
- Lambda authorizers will reject unauthenticated requests at the application layer, so the WAF gap is mitigated downstream

**Verdict:** The implementation is clever and functional. The token-refresh bypass is theoretical with low practical impact. The unauthenticated fallback to IP-only limiting is acceptable given Lambda authorizer enforcement.

### 5.5 Additional Managed Rule Groups

| Rule Group | Recommendation | Justification |
|------------|---------------|---------------|
| AWSManagedRulesSQLiRuleSet | **Add in count-only mode** | The platform uses RDS PostgreSQL. Although Lambda handlers use parameterized queries (`postgres` library with tagged templates), defense-in-depth is warranted. Count-only initially avoids blocking legal content containing SQL-like keywords ("order", "select", "union" are common in legal text). Monitor false-positive rate for 2–4 weeks before promoting to block mode. |
| AWSManagedRulesLinuxRuleSet | **Skip** | Lambda functions run in a managed runtime environment where OS-level command injection is not exploitable. The attack surface targeted by this rule group (path traversal, shell injection) is not relevant when code does not execute system commands or access a traditional filesystem. |
| AWSManagedRulesKnownBadInputsRuleSet | **Add in block mode** | Protects against Log4j (Log4Shell), Java deserialization, and other known exploit patterns. Low false-positive risk for legal content. Immediate value with negligible maintenance cost. This rule group is already absent from both WAF ACLs — adding it is a quick defense-in-depth win. |

### 5.6 Size Constraint Rules

**Current State:** No WAF size constraint rules are configured on the API Gateway WAF. The CDK code contains no `SizeConstraintStatement` in the WAF rule set.

**Relevant Limits:**
- API Gateway REST API default payload limit: 10 MB
- Lambda synchronous invocation payload limit: 6 MB (request) / 6 MB (response)
- CloudFront maximum request body for WAF inspection: 64 KB (default), up to 64 KB forwarded to WAF without Body field truncation

**Assessment:**
- Without WAF size constraints, oversized payloads are only rejected by API Gateway's 10 MB hard limit or Lambda's 6 MB limit
- For the legal AI use case, legitimate large payloads include: long legal documents submitted for summarization, audio file references, and case context for AI chat
- The AWSManagedRulesCommonRuleSet includes `SizeRestrictions_BODY` which limits request body to 8 KB by default — but the `overrideAction: { none: {} }` configuration means this rule IS active and will block requests with bodies exceeding 8 KB

**Gap:** The `SizeRestrictions_BODY` rule within `AWSManagedRulesCommonRuleSet` has a default 8 KB body size limit. This is likely too restrictive for a legal AI platform where users submit multi-page legal documents for analysis. If this rule is not excluded or overridden, it will block legitimate long-form legal content submissions to AI endpoints.

**Recommendation:** Add an explicit rule exclusion for `SizeRestrictions_BODY` in the managed rule group configuration, and replace it with a custom size constraint rule that enforces a reasonable limit aligned with the application's needs (e.g., 1 MB for AI text endpoints, lower for other endpoints).

### 5.7 CloudFront vs API Gateway WAF Gaps

| Capability | CloudFront WAF (`waf-stack.ts`) | API Gateway WAF (`api-stack.ts`) | Gap Assessment |
|-----------|-------------------------------|----------------------------------|----------------|
| AWSManagedRulesCommonRuleSet | ✅ Priority 1 | ✅ Priority 1 | Aligned — defense-in-depth at both layers |
| IP-based rate limiting | 1000 req/5min | 2000 req/5min | Intentionally layered — CloudFront (frontend assets + API passthrough) has stricter limit; API Gateway has more permissive limit for requests that pass through CloudFront |
| Per-user rate limiting | ❌ Not configured | ✅ 200 req/5min (MD5 Authorization) | **Gap:** CloudFront WAF has no per-user limiting. This is acceptable because CloudFront primarily serves static frontend assets (Amplify SPA) where per-user limiting is less relevant |
| KnownBadInputsRuleSet | ❌ Not configured | ❌ Not configured | **Gap:** Neither WAF has KnownBadInputs protection. Recommend adding to both. |
| Geo-restriction | ❌ Not configured | ❌ Not configured | **Gap:** Neither WAF restricts by geography. For a Canadian legal education platform, consider geo-blocking at CloudFront level (see Section 4.4) |
| Bot control | ❌ Not configured | ❌ Not configured | Lower priority — platform requires authentication; unauthenticated bots are stopped by authorizers |
| WAF Logging | ❌ Not configured in CDK | ❌ Not configured in CDK | **Gap:** Neither WAF has logging configured in infrastructure code. Critical for incident response |
| Size constraints | Via CommonRuleSet only | Via CommonRuleSet only | Both rely on default CommonRuleSet `SizeRestrictions_BODY` (8 KB) — may be too restrictive for legal content |

**Key Gaps Requiring Remediation:**
1. WAF logging absent on both ACLs (see 5.9)
2. KnownBadInputsRuleSet missing from both
3. No geo-restriction at either layer

**Intentional Layering (Acceptable):**
- IP rate limit differential (1000 vs 2000) is correct — CloudFront sees all traffic including static assets; API Gateway sees only API calls
- Per-user limit only on API Gateway is correct — CloudFront doesn't have access to the Authorization header for static assets

### 5.8 WebSocket API WAF Coverage

**Current State:** The WebSocket API (`ChatWebSocketApi`) is NOT associated with any WAF Web ACL. No `CfnWebACLAssociation` exists for the WebSocket API in the CDK code.

**Existing Controls:**
- Lambda authorizer (`wsAuthorizer`) validates JWT tokens on `$connect` route — only authenticated users can establish connections
- Stage-level throttling configured: 100 req/s rate, 200 burst (added as fix for CDK-M6/S-H3)
- Per-connection message handling in `default.js` handler with application-level logic

**Evidence** (`cdk/lib/api-stack.ts`):
```typescript
this.wsStage = new apigwv2.WebSocketStage(this, `${id}-WsStage`, {
  webSocketApi: this.wsApi,
  stageName: "prod",
  autoDeploy: true,
  throttle: {
    rateLimit: 100,  // 100 requests per second
    burstLimit: 200, // Allow bursts up to 200
  },
});
```

**Risk Assessment:**
- **WAF inspection gap:** WebSocket messages bypass WAF rule evaluation entirely. Malicious payloads (XSS, injection) sent via WebSocket are not inspected by `AWSManagedRulesCommonRuleSet`
- **Mitigating factors:**
  - Authentication required (Lambda authorizer on $connect)
  - Stage throttling limits message volume (100/s is generous but bounded)
  - Downstream AI functions have Bedrock guardrails for content filtering
  - Message content passes through application-layer validation before processing
- **Residual risk:** An authenticated malicious user can send crafted payloads that would be blocked by WAF on REST API but pass unfiltered on WebSocket
- **AWS limitation:** AWS WAFv2 supports WebSocket API association for API Gateway V2 (HTTP APIs and WebSocket APIs), but it only inspects the `$connect` request — subsequent messages are not inspected by WAF

**Recommendation:** A WAF association on the WebSocket API provides limited value since only the initial `$connect` is inspected (the authorizer already validates this). The greater risk is from message content — this should be mitigated through application-layer input validation in the WebSocket `default.js` handler and downstream Lambda functions, which is already partially addressed by Bedrock guardrails. Adding a WAF association is a low-effort improvement (inspects connection request headers) but does not address the core gap of uninspected message payloads.

### 5.9 WAF Logging Status

**Current State:** No WAF logging configuration exists in the CDK code for the API Gateway WAF Web ACL.

Searching the entire `api-stack.ts` reveals no `CfnLoggingConfiguration` resource associated with the WAF. The WAF has `cloudWatchMetricsEnabled: true` and `sampledRequestsEnabled: true` for visibility, but these provide only:
- Aggregate CloudWatch metrics (request counts, block counts per rule)
- Sampled requests (subset of requests viewable in WAF console for up to 3 hours)

**What is missing:**
- Full request logging to a persistent store (S3, CloudWatch Logs, or Kinesis Data Firehose)
- Request URI, source IP, matched rule, action taken, and request headers for blocked/counted requests
- Historical log data for incident investigation (sampled requests are retained only 3 hours)

**Impact:**
- During a security incident, there is no way to retrospectively analyze which requests were blocked, by which rule, or identify attack patterns
- Rate-limit triggers cannot be correlated with specific user activity without full logs
- Compliance requirements for log retention (90+ days) cannot be met

**Recommendation:** Add WAF logging to CloudWatch Logs (simplest integration with existing infrastructure) or S3 (lower cost for high-volume logging). The log group must be named with the required `aws-waf-logs-` prefix:

```typescript
const wafLogGroup = new logs.LogGroup(this, `${id}-WafApiLogs`, {
  logGroupName: `aws-waf-logs-${id}-api-gateway`,
  retention: logs.RetentionDays.THREE_MONTHS,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

new wafv2.CfnLoggingConfiguration(this, `${id}-WafLogging`, {
  resourceArn: waf.attrArn,
  logDestinationConfigs: [wafLogGroup.logGroupArn],
});
```

### Findings

| ID | Title | Severity | Effort | Status |
|----|-------|----------|--------|--------|
| NW-H1 | No WAF logging on API Gateway WAF — no incident response capability | High | Low | New |
| NW-H2 | AWSManagedRulesCommonRuleSet `SizeRestrictions_BODY` (8 KB) likely blocks legitimate legal content | High | Low | New |
| NW-M1 | AWSManagedRulesKnownBadInputsRuleSet not configured — Log4Shell and known exploit patterns unprotected | Medium | Low | New |
| NW-M2 | Per-user rate limit bypassed on token refresh (new MD5 hash resets counter) | Medium | Medium | New |
| NW-M3 | WebSocket API not associated with WAF — connection-level inspection missing | Medium | Low | New |
| NW-M4 | No AWSManagedRulesSQLiRuleSet — defense-in-depth gap for RDS PostgreSQL backend | Medium | Low | New |
| NW-L1 | No custom block response body — blocked users receive generic 403 with no guidance | Low | Low | New |

---

#### NW-H1: No WAF Logging on API Gateway WAF

- **Severity:** High
- **Section:** 5. WAF API Gateway Assessment
- **Current State:** The WAF (`${id}-waf`) has `cloudWatchMetricsEnabled: true` and `sampledRequestsEnabled: true` but no `CfnLoggingConfiguration` resource. Sampled requests are retained for only 3 hours in the AWS console.
- **Gap:** No persistent WAF request logs exist. During a security incident, teams cannot determine which requests were blocked, identify attack source IPs, or analyze attack patterns beyond the 3-hour sample window.
- **Risk:** Incident response is severely impaired. A coordinated attack could go unanalyzed. Compliance requirements for 90-day log retention cannot be met. Rate-limit blocks cannot be correlated to specific users for support investigation.
- **Recommendation:** Add `CfnLoggingConfiguration` with a CloudWatch Logs log group (prefix `aws-waf-logs-`) and 90-day minimum retention. Optionally add redacted field configuration to exclude sensitive headers from logs.
- **Effort:** Low — configuration-only CDK change, no application code modification
- **Cross-References:** Related to monitoring gaps (Section 7.3)
- **Status:** New

---

#### NW-H2: SizeRestrictions_BODY in CommonRuleSet Blocks Legal Content

- **Severity:** High
- **Section:** 5. WAF API Gateway Assessment
- **Current State:** `AWSManagedRulesCommonRuleSet` is applied with `overrideAction: { none: {} }`, meaning all rules within it (including `SizeRestrictions_BODY` with an 8 KB body limit) are active in their default action mode (block).
- **Gap:** Legal documents submitted for AI analysis (summarization, chat context, case creation) frequently exceed 8 KB. A 5,000-word legal document is approximately 30 KB. These legitimate requests are blocked by the WAF before reaching the application.
- **Risk:** Legitimate user functionality is broken — advocates cannot submit long legal documents for AI-assisted analysis. This is a functional regression disguised as a security rule.
- **Recommendation:** Add a rule exclusion for `SizeRestrictions_BODY` within the managed rule group configuration:
  ```typescript
  managedRuleGroupStatement: {
    vendorName: "AWS",
    name: "AWSManagedRulesCommonRuleSet",
    excludedRules: [{ name: "SizeRestrictions_BODY" }],
  },
  ```
  Then add a custom size constraint rule with appropriate limits (e.g., 1 MB for `/student/*/chat` and `/admin/playground` endpoints, 256 KB for other endpoints).
- **Effort:** Low — CDK configuration change
- **Cross-References:** Relates to Section 10.4 (false-positive risk for legal content)
- **Status:** New

---

#### NW-M1: KnownBadInputsRuleSet Not Configured

- **Severity:** Medium
- **Section:** 5. WAF API Gateway Assessment
- **Current State:** Neither the API Gateway WAF nor the CloudFront WAF includes `AWSManagedRulesKnownBadInputsRuleSet`. Only `AWSManagedRulesCommonRuleSet` and rate-limiting rules are configured.
- **Gap:** Known exploit patterns including Log4Shell (CVE-2021-44228), Java deserialization attacks, and host-header injection are not blocked at the WAF layer. While the Node.js/Python runtime makes Log4j irrelevant to this application, other patterns in this rule group (e.g., PROPFIND, malicious user-agents) provide broad protection.
- **Risk:** Known-bad request signatures that could probe for vulnerabilities pass through to the application layer. Defense-in-depth is weakened.
- **Recommendation:** Add `AWSManagedRulesKnownBadInputsRuleSet` at priority 0 (before CommonRuleSet) in block mode. This rule group has very low false-positive rates for typical web applications.
- **Effort:** Low — single rule addition in CDK WAF configuration
- **Cross-References:** Same gap exists on CloudFront WAF (Section 4.3)
- **Status:** New

---

#### NW-M2: Per-User Rate Limit Bypass via Token Refresh

- **Severity:** Medium
- **Section:** 5. WAF API Gateway Assessment
- **Current State:** Per-user rate limiting uses MD5 hash of the `Authorization` header. Cognito access tokens have 30-minute validity (`accessTokenValidity: cdk.Duration.minutes(30)`). When a token refreshes, a new JWT is issued with a different signature, producing a different MD5 hash.
- **Gap:** A user whose rate limit is exhausted can force a token refresh (via Cognito refresh token) to obtain a new JWT, which the WAF treats as a different identity. This effectively doubles the per-user limit to 400 req/5 min.
- **Risk:** A motivated attacker can bypass per-user rate limiting by programmatically refreshing tokens. Practical impact is limited because: (a) the IP-based limit (2000/5 min) still applies, (b) Cognito rate-limits refresh operations, and (c) the doubled limit (400/5 min) is still below the IP limit.
- **Recommendation:** Accept this as a known limitation of header-based rate limiting. For stronger enforcement, implement application-level rate limiting using the stable Cognito `sub` claim (user UUID) extracted from the JWT in Lambda authorizers. This is already partially done via the `check_and_increment_usage()` function in AI Lambda handlers.
- **Effort:** Medium — requires application-level rate limiting enhancement for non-AI endpoints
- **Cross-References:** S-H1 (rate limit race condition — Fixed), S-H2 (rate limit fails open — Fixed)
- **Status:** New

---

#### NW-M3: WebSocket API Not Associated with WAF

- **Severity:** Medium
- **Section:** 5. WAF API Gateway Assessment
- **Current State:** The WebSocket API (`ChatWebSocketApi`) has no `CfnWebACLAssociation`. It relies on Lambda authorizer authentication on `$connect` and stage throttling (100 req/s, 200 burst).
- **Gap:** The `$connect` request is not inspected by WAF rules (CommonRuleSet, rate limits). A malicious client could send crafted headers during connection establishment that would be blocked on the REST API but pass unfiltered on WebSocket.
- **Risk:** Low-to-moderate. The Lambda authorizer validates JWT authentication (primary control), and AWS WAFv2 for WebSocket APIs only inspects the `$connect` request (subsequent messages bypass WAF regardless). Adding WAF provides marginal additional protection for the connection handshake.
- **Recommendation:** Add a WAF association for the WebSocket API stage with at minimum `AWSManagedRulesCommonRuleSet` and IP-based rate limiting. While the incremental security gain is modest (authorizer already validates), it provides defense-in-depth and consistent security posture across both APIs.
- **Effort:** Low — CDK configuration adding `CfnWebACLAssociation` for WebSocket stage
- **Cross-References:** CDK-M6 (WebSocket throttling — Fixed), S-H3 (WebSocket no throttling — Fixed)
- **Status:** New

---

#### NW-M4: No SQLi Rule Set — Defense-in-Depth Gap

- **Severity:** Medium
- **Section:** 5. WAF API Gateway Assessment
- **Current State:** `AWSManagedRulesSQLiRuleSet` is not included in the API Gateway WAF configuration. The application uses parameterized queries via the `postgres` library (tagged template literals) which prevents SQL injection at the application layer.
- **Gap:** If a future code change introduces a SQL injection vulnerability (e.g., string concatenation in a query), there is no WAF-layer defense to catch it. The WAF currently relies on `AWSManagedRulesCommonRuleSet` which has basic SQLi detection but not the comprehensive pattern matching of the dedicated SQLi rule set.
- **Risk:** Low immediate risk due to parameterized queries, but defense-in-depth principle is violated. Legal content containing SQL-like keywords ("ORDER BY", "SELECT", "UNION") creates false-positive risk if deployed in block mode.
- **Recommendation:** Add `AWSManagedRulesSQLiRuleSet` in **count-only mode** initially. Monitor CloudWatch metrics for 2–4 weeks to measure false-positive rate against legitimate legal content, then promote to block mode if false positives are acceptably low.
- **Effort:** Low — CDK configuration change with `overrideAction: { count: {} }`
- **Cross-References:** Relates to Section 10.4 (false-positive assessment for legal content)
- **Status:** New

---

#### NW-L1: No Custom Block Response on WAF Rules

- **Severity:** Low
- **Section:** 5. WAF API Gateway Assessment
- **Current State:** WAF rules use the default `block` action with no `customResponse` configuration. Blocked requests receive a generic HTTP 403 response with no body or guidance.
- **Gap:** When legitimate users are rate-limited (especially on shared campus networks), they receive an opaque 403 with no explanation. This generates support tickets and user confusion.
- **Risk:** User experience degradation; no direct security risk. Support overhead from users who don't understand why their requests are failing.
- **Recommendation:** Add custom response bodies to rate-limit rules:
  ```typescript
  action: {
    block: {
      customResponse: {
        responseCode: 429,
        customResponseBodyKey: "rate-limited",
      },
    },
  },
  customResponseBodies: {
    "rate-limited": {
      contentType: "APPLICATION_JSON",
      content: '{"error": "Too many requests. Please wait a few minutes and try again."}',
    },
  },
  ```
  Use HTTP 429 (Too Many Requests) instead of 403 for rate-limit blocks to allow client-side retry logic.
- **Effort:** Low — CDK configuration change
- **Cross-References:** None
- **Status:** New

---

## 6. Transport Security Assessment

> *Requirement 5: Document Transport Security (TLS/SSL) Assessment*

This section assesses TLS/SSL enforcement across all communication channels, identifying certificate validation bypasses, missing explicit TLS parameters, and minimum version enforcement gaps.

### 6.1 TLS Enforcement per Communication Path

| Path | TLS Version | Enforcement | Certificate Validation | Assessment |
|------|-------------|-------------|------------------------|------------|
| Client → CloudFront | TLS 1.2+ (AWS default) | Mandatory — CloudFront rejects non-HTTPS | AWS-managed certificate (ACM or Amplify) | **Adequate** — Amplify enforces HTTPS with HSTS headers (`max-age=31536000; includeSubDomains`) configured in `amplify-stack.ts` |
| CloudFront → API Gateway | TLS 1.2 | Mandatory — API Gateway regional endpoint accepts HTTPS only | AWS-managed; CloudFront validates API GW certificate | **Adequate** — AWS-to-AWS internal path, always encrypted |
| API Gateway → Lambda | N/A (internal) | AWS internal invocation — not a network hop | N/A | **Adequate** — Lambda invocation is an internal AWS API call over the AWS backbone, not a TCP connection |
| Lambda → RDS Proxy | TLS 1.2+ | **Inconsistent** — see findings below | **BYPASSED in handlers** — `rejectUnauthorized: false` in Node.js REST handlers; `sslmode` missing in 3 of 5 Python functions | **Gaps identified — see NW-H1, NW-H2** |
| RDS Proxy → RDS | TLS 1.2+ | Enforced by `requireTLS: true` on proxy AND `rds.force_ssl = 1` on RDS | AWS-managed internal certificate validation | **Adequate** — Hop-by-hop design is expected (see §6.3) |
| Lambda → AWS Services | TLS 1.2+ | Mandatory — AWS SDK v3 (Node.js) and boto3 (Python) always use HTTPS | AWS SDK validates service certificates against system CA store | **Adequate** — All AWS service connections (Secrets Manager, Bedrock, S3, DynamoDB, SSM, EventBridge, SES, Cognito, Transcribe) use HTTPS by default |

### 6.2 RDS `force_ssl` Parameter

**Current Configuration:**

```typescript
// cdk/lib/database-stack.ts — parameter group
const parameterGroup = new rds.ParameterGroup(this, `${id}-rdsParameterGroup`, {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.of("17.10", "17"),
  }),
  parameters: {
    "rds.force_ssl": "1", // Enable SSL requirement
  },
});
```

**Enforcement Behavior:**
- When `rds.force_ssl = 1`, PostgreSQL rejects any connection that does not negotiate an SSL/TLS handshake at the protocol level
- A non-SSL connection attempt receives: `FATAL: no pg_hba.conf entry for host "x.x.x.x", user "...", database "...", SSL off`
- This applies regardless of whether the client specifies `sslmode` — the server itself rejects plaintext connections
- **Assessment:** Correctly configured. This provides a server-side safety net even when client-side SSL configuration is missing or misconfigured. However, `force_ssl` alone does NOT ensure certificate validation — it only ensures the connection is encrypted. A client with `rejectUnauthorized: false` still negotiates TLS but accepts any certificate (vulnerable to MITM).

### 6.3 RDS Proxy `requireTLS` Assessment

**Current Configuration:**

```typescript
// cdk/lib/database-stack.ts — RDS Proxy
const rdsProxy = this.dbInstance.addProxy(id + "-proxy", {
  secrets: [this.secretPathUser!, this.secretPathTableCreator!, this.secretPathAdmin],
  vpc: vpcStack.vpc,
  role: rdsProxyRole,
  securityGroups: this.dbInstance.connections.securityGroups,
  requireTLS: true, // Enable TLS requirement for secure connections
});
```

**Encryption Architecture (Hop-by-Hop):**

```
Lambda ──TLS 1.2+──► RDS Proxy ──TLS 1.2+──► RDS Instance
         (hop 1)                   (hop 2)
```

- **Hop 1 (Lambda → RDS Proxy):** `requireTLS: true` means the proxy rejects any client connection that does not use TLS. The proxy terminates the TLS session from the client.
- **Hop 2 (RDS Proxy → RDS):** The proxy establishes a NEW TLS connection to the backend RDS instance. Since `rds.force_ssl = 1` is set, this hop is always encrypted.
- **Implication:** TLS is terminated and re-established at the proxy layer. Data is encrypted in transit on both hops, but the proxy has access to plaintext data in memory for connection pooling. This is the expected and documented AWS behavior for RDS Proxy.
- **Assessment:** Acceptable design. The proxy runs within the same VPC private-isolated subnet as the RDS instance, and both are within the AWS trust boundary. Continuous end-to-end encryption would require a direct connection (bypassing the proxy), sacrificing connection pooling benefits.

### 6.4 Certificate Validation in Lambda Functions

#### 6.4.1 Node.js REST API Handlers — CRITICAL BYPASS

**File:** `cdk/lambda/handlers/initializeConnection.js`

```javascript
global.sqlConnection = postgres({
  host: RDS_PROXY_ENDPOINT,
  port: credentials.port || 5432,
  username: credentials.username,
  password: credentials.password,
  database: credentials.dbname,
  ssl: { rejectUnauthorized: false },  // ⚠️ CERTIFICATE VALIDATION DISABLED
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
});
```

**Impact:** This connection module is used by ALL REST API Lambda handlers:
- `adminFunction.js` — Admin role API handler
- `instructorFunction.js` — Instructor role API handler
- `studentFunction.js` — Student/advocate role API handler

With `rejectUnauthorized: false`, the client accepts ANY TLS certificate presented by the server, including self-signed, expired, or attacker-controlled certificates. In a VPC environment, the risk is mitigated because traffic flows within private subnets, but it violates defense-in-depth principles.

#### 6.4.2 Node.js Database Migration Handler — SAME BYPASS

**File:** `cdk/lambda/db_setup/index.js`

```javascript
function dbConnectionConfig(secret, hostOverride) {
  return {
    user: secret.username,
    password: secret.password,
    host: hostOverride || secret.host,
    database: secret.dbname,
    port: secret.port || 5432,
    ssl: { rejectUnauthorized: false },  // ⚠️ CERTIFICATE VALIDATION DISABLED
  };
}
```

**Impact:** Migration Lambda connects to RDS Proxy with disabled certificate validation. Lower severity since this runs only during deployments, not on user-facing traffic paths.

#### 6.4.3 Node.js Authorizer Functions — PROPERLY CONFIGURED

**File:** `cdk/lambda/authorization/initializeConnection.js`

```javascript
global.sqlConnection = postgres({
  host: RDS_PROXY_ENDPOINT,
  port: credentials.port || 5432,
  database: credentials.dbname,
  username: credentials.username,
  password: credentials.password,
  ssl: "require",  // ✓ SSL required (but no explicit CA validation)
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
});
```

**Assessment:** `ssl: "require"` ensures TLS is negotiated but relies on the system's default CA store for validation (Node.js default behavior when `rejectUnauthorized` is not explicitly set to `false`). This is acceptable — the `postgres` library defaults to `rejectUnauthorized: true` when `ssl` is set to `"require"` string mode.

#### 6.4.4 Python Lambda Functions — INCONSISTENT SSL CONFIGURATION

| Function | File | `sslmode` Specified | Assessment |
|----------|------|---------------------|------------|
| assess_progress | `cdk/lambda/assess_progress/src/main.py` | **Yes** (`sslmode: 'require'`) | ✓ Properly configured |
| text_generation | `cdk/lambda/text_generation/src/main.py` | **No** | ⚠️ Missing — relies on server-side `force_ssl` |
| summary_generation | `cdk/lambda/summary_generation/src/main.py` | **No** | ⚠️ Missing — relies on server-side `force_ssl` |
| audioToText | `cdk/lambda/audioToText/src/main.py` | **No** | ⚠️ Missing — relies on server-side `force_ssl` |
| case_generation | `cdk/lambda/case_generation/src/main.py` | **No** | ⚠️ Missing — relies on server-side `force_ssl` |
| playground_generation | `cdk/lambda/playground_generation/src/main.py` | N/A (no DB connection) | N/A |

**Example of MISSING sslmode** (`text_generation/src/main.py`):

```python
connection_params = {
    'dbname': secret["dbname"],
    'user': secret["username"],
    'password': secret["password"],
    'host': RDS_PROXY_ENDPOINT,
    'port': secret["port"]
    # ⚠️ NO 'sslmode' parameter
}
connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])
connection = psycopg.connect(connection_string)
```

**Example of CORRECT configuration** (`assess_progress/src/main.py`):

```python
connection_params = {
    'dbname': secret["dbname"],
    'user': secret["username"],
    'password': secret["password"],
    'host': RDS_PROXY_ENDPOINT,
    'port': secret["port"],
    'sslmode': 'require'  # ✓ Require SSL connection
}
```

**Mitigation Context:** The missing `sslmode` in Python functions is partially mitigated by:
1. `rds.force_ssl = 1` on the server rejects non-SSL connections
2. `requireTLS: true` on RDS Proxy rejects non-SSL connections
3. psycopg3 default behavior: when connecting to a PostgreSQL server that requires SSL (via `force_ssl`), psycopg will automatically negotiate TLS even without explicit `sslmode`

However, without explicit `sslmode: 'require'`, the client would attempt a plaintext connection first, only upgrading to SSL after the server rejects it (or via PostgreSQL's SSL negotiation protocol). This is an unnecessary round-trip and a defense-in-depth gap.

#### 6.4.5 WebSocket Handlers — No Direct TLS Concerns

**Files:** `cdk/lambda/websocket/connect.js`, `disconnect.js`, `default.js`

WebSocket handlers communicate with DynamoDB and API Gateway Management API via AWS SDK, which always uses TLS. No direct database connections are made from WebSocket handlers. No TLS configuration concerns.

### 6.5 Minimum TLS Version Assessment

| Layer | Minimum TLS Version | Configuration Source | Assessment |
|-------|---------------------|---------------------|------------|
| CloudFront (Amplify) | TLS 1.2 | AWS Amplify default (not configurable via CDK for Amplify-managed distributions) | ✓ Adequate |
| API Gateway (REST) | TLS 1.2 | AWS default for REST API endpoints (`SecurityPolicy: TLS_1_2`) — no explicit override in `api-stack.ts` | ✓ Adequate — AWS enforces TLS 1.2 minimum on regional API Gateway endpoints by default |
| API Gateway (WebSocket) | TLS 1.2 | AWS default for WebSocket API endpoints | ✓ Adequate |
| RDS Proxy | TLS 1.2 | AWS RDS Proxy only supports TLS 1.2+ | ✓ Adequate |
| RDS PostgreSQL 17 | TLS 1.2 | PostgreSQL 17 on RDS uses TLS 1.2 minimum by default; `ssl_min_protocol_version` not explicitly set but defaults to TLSv1.2 on modern RDS | ✓ Adequate |
| AWS SDK (Node.js v3) | TLS 1.2 | Node.js 24.x runtime uses OpenSSL 3.x which defaults to TLS 1.2 minimum | ✓ Adequate |
| AWS SDK (boto3/Python 3.12) | TLS 1.2 | Python 3.12 ssl module defaults to TLS 1.2 minimum | ✓ Adequate |

**Assessment:** No layer permits TLS versions below 1.2. The platform meets the TLS 1.2 minimum requirement across all communication paths without requiring explicit configuration, due to the modern runtime versions (Node.js 24.x, Python 3.12) and AWS service defaults.

### 6.6 RDS CA Bundle and Rotation

**Current State:**
- No explicit CA bundle is referenced in any Lambda function's database connection configuration
- The Node.js REST handlers use `ssl: { rejectUnauthorized: false }` which bypasses CA validation entirely
- The Node.js authorizer uses `ssl: "require"` which relies on the system CA store (Node.js built-in CA bundle includes Amazon Root CAs)
- Python functions using `sslmode: 'require'` (or no sslmode) rely on the system CA store (`/etc/ssl/certs/ca-certificates.crt` in Lambda runtime) which includes Amazon Root CAs
- No function explicitly specifies `sslrootcert` (Python) or `ssl.ca` (Node.js) pointing to the RDS CA bundle

**RDS CA Certificate Chain:**
- RDS instances in this deployment use the `rds-ca-rsa2048-g1` certificate authority (AWS default for new instances created after January 2024)
- The Amazon Root CA that signs RDS certificates is included in the default system CA stores of both Node.js 24.x and Python 3.12 Lambda runtimes
- This means certificate validation WORKS without explicit CA bundle configuration — but only for functions that don't disable it

**Rotation Handling:**
- AWS manages RDS certificate rotation automatically via the `rds-ca-rsa2048-g1` authority
- Since no explicit CA bundle file is referenced, rotation does NOT require application code changes
- However, the CDK does not set `caCertificateIdentifier` on the `DatabaseInstance`, meaning it uses the AWS default CA which auto-rotates
- **Risk:** If AWS retires the current root CA and the Lambda runtime CA store is not updated in time, connections would fail. This is a theoretical risk; AWS provides significant advance notice (12+ months) and updates Lambda runtimes ahead of CA rotations.

**Assessment:** The implicit CA handling (relying on system CA stores) is acceptable for functions that perform validation. The primary concern is that the REST handlers disable validation entirely (`rejectUnauthorized: false`), making CA bundle considerations irrelevant for those paths — they would accept any certificate regardless.

### Findings

| ID | Title | Severity | Effort | Status |
|----|-------|----------|--------|--------|
| NW-H1 | Certificate validation disabled (`rejectUnauthorized: false`) in REST API database connections | High | Low | New |
| NW-H2 | Python AI Lambda functions missing explicit `sslmode` in database connections | High | Low | New |
| NW-M1 | Database migration Lambda uses `rejectUnauthorized: false` | Medium | Low | New |
| NW-L1 | No explicit RDS CA bundle reference in connection configuration | Low | Low | New |

---

### Finding Details

#### NW-H1: Certificate validation disabled (`rejectUnauthorized: false`) in REST API database connections

- **Severity:** High
- **Section:** 6. Transport Security Assessment
- **Current State:** `cdk/lambda/handlers/initializeConnection.js` configures the postgres client with `ssl: { rejectUnauthorized: false }`. This connection module is used by ALL three role-based REST API handlers (`adminFunction.js`, `instructorFunction.js`, `studentFunction.js`) serving the entire application's REST API traffic.
- **Gap:** Certificate validation is explicitly disabled, meaning the client accepts any TLS certificate presented during the handshake — including expired, self-signed, or attacker-controlled certificates. This violates the defense-in-depth principle even though traffic is within a VPC.
- **Risk:** If an attacker achieves network position within the VPC (compromised Lambda, misconfigured security group, or VPC peering to a compromised account), they could intercept database traffic via a man-in-the-middle attack. The connection would appear encrypted but would terminate at the attacker's proxy. Given the platform handles privileged legal content (attorney-client communications), this is classified as High severity.
- **Recommendation:** Change `ssl: { rejectUnauthorized: false }` to `ssl: "require"` (matching the authorizer pattern) in `cdk/lambda/handlers/initializeConnection.js`:
  ```javascript
  global.sqlConnection = postgres({
    host: RDS_PROXY_ENDPOINT,
    port: credentials.port || 5432,
    username: credentials.username,
    password: credentials.password,
    database: credentials.dbname,
    ssl: "require",  // Validates against system CA store
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  ```
  The `postgres` (postgresjs) library with `ssl: "require"` defaults to `rejectUnauthorized: true`, which validates the RDS Proxy certificate against the Node.js built-in CA bundle (which includes Amazon Root CAs).
- **Effort:** Low (single-line change, same pattern already proven in the authorizer module)
- **Cross-References:** `RDS-H3` (code-review-rds.md — handler connection module security, same file `initializeConnection.js`)
- **Status:** New

---

#### NW-H2: Python AI Lambda functions missing explicit `sslmode` in database connections

- **Severity:** High
- **Section:** 6. Transport Security Assessment
- **Current State:** Four Python Lambda functions (`text_generation`, `summary_generation`, `audioToText`, `case_generation`) construct database connection strings WITHOUT specifying `sslmode`. Example from `text_generation/src/main.py`:
  ```python
  connection_params = {
      'dbname': secret["dbname"],
      'user': secret["username"],
      'password': secret["password"],
      'host': RDS_PROXY_ENDPOINT,
      'port': secret["port"]
      # sslmode NOT specified
  }
  ```
  Only `assess_progress/src/main.py` correctly includes `'sslmode': 'require'`.
- **Gap:** Without explicit `sslmode`, the client relies entirely on server-side enforcement (`rds.force_ssl` and `requireTLS`) to negotiate TLS. While this currently works (connection succeeds because the server forces SSL negotiation), it creates a fragile dependency: if the RDS parameter group or proxy TLS setting is ever accidentally changed, these functions would silently connect in plaintext.
- **Risk:** Defense-in-depth violation. The intent to use TLS is not explicitly declared by the client, creating a configuration fragility. Additionally, without `sslmode`, psycopg3 may attempt a plaintext connection first before the server forces the upgrade, creating an unnecessary protocol negotiation step that could theoretically be intercepted in the initial bytes.
- **Recommendation:** Add `'sslmode': 'require'` to all Python database connection parameters, matching the `assess_progress` pattern:
  ```python
  connection_params = {
      'dbname': secret["dbname"],
      'user': secret["username"],
      'password': secret["password"],
      'host': RDS_PROXY_ENDPOINT,
      'port': secret["port"],
      'sslmode': 'require'
  }
  ```
  Apply to: `text_generation/src/main.py`, `summary_generation/src/main.py`, `audioToText/src/main.py`, `case_generation/src/main.py`.
- **Effort:** Low (4 one-line additions, pattern already proven in `assess_progress`)
- **Cross-References:** None (new finding specific to Python functions)
- **Status:** New

---

#### NW-M1: Database migration Lambda uses `rejectUnauthorized: false`

- **Severity:** Medium
- **Section:** 6. Transport Security Assessment
- **Current State:** `cdk/lambda/db_setup/index.js` uses `ssl: { rejectUnauthorized: false }` in the `dbConnectionConfig` function for database migration operations.
- **Gap:** Same certificate validation bypass as NW-H1, but in a lower-risk context since the migration Lambda:
  - Runs only during CDK deployments (not on user traffic paths)
  - Executes for brief periods during schema changes
  - Is not exposed to user-controlled inputs
- **Risk:** Limited exposure window, but still violates the principle of consistent security configuration. If an attacker has VPC network access during a deployment, they could intercept migration traffic containing schema DDL and potentially inject malicious schema changes.
- **Recommendation:** Change to `ssl: "require"` in `cdk/lambda/db_setup/index.js`:
  ```javascript
  function dbConnectionConfig(secret, hostOverride) {
    return {
      user: secret.username,
      password: secret.password,
      host: hostOverride || secret.host,
      database: secret.dbname,
      port: secret.port || 5432,
      ssl: { rejectUnauthorized: true },  // or ssl: "require" if using postgres.js
    };
  }
  ```
  Note: `db_setup` uses the `pg` library (not `postgres.js`), so the configuration should be `ssl: { rejectUnauthorized: true }` to use the system CA store.
- **Effort:** Low (single-line change)
- **Cross-References:** NW-H1 (same pattern, different Lambda)
- **Status:** New

---

#### NW-L1: No explicit RDS CA bundle reference in connection configuration

- **Severity:** Low
- **Section:** 6. Transport Security Assessment
- **Current State:** No Lambda function explicitly references the AWS RDS CA bundle file (`rds-combined-ca-bundle.pem` or `global-bundle.pem`) in its connection configuration. Certificate validation (where enabled) relies on the Lambda runtime's system CA store.
- **Gap:** Relying on the system CA store is broader than necessary — it trusts all CAs in the bundle, not just the Amazon Root CA that signs RDS certificates. Pinning to the specific RDS CA bundle would provide a tighter trust anchor.
- **Risk:** Minimal practical risk. The system CA stores in AWS Lambda runtimes (Node.js 24.x, Python 3.12) are maintained by AWS and include the correct Amazon Root CAs. The broader trust surface is a theoretical concern — an attacker would need a certificate signed by ANY trusted CA for the RDS Proxy hostname, which is an internal VPC DNS name that no public CA would issue certificates for.
- **Recommendation:** For functions that perform certificate validation (authorizers, and REST handlers after NW-H1 remediation), consider adding explicit CA bundle reference as a hardening measure:
  - Node.js: Include `/opt/rds-combined-ca-bundle.pem` via a Lambda layer and set `ssl: { ca: fs.readFileSync('/opt/rds-combined-ca-bundle.pem') }`
  - Python: Set `sslrootcert=/opt/rds-combined-ca-bundle.pem` in connection params
  
  This is a defense-in-depth enhancement, not a critical fix. Prioritize NW-H1 and NW-H2 first.
- **Effort:** Low (add CA bundle to Lambda layer, update connection config)
- **Cross-References:** None
- **Status:** New

---

## 7. Network Monitoring Assessment

> *Requirement 6: Document VPC Flow Log and Network Monitoring Assessment*

This section assesses network monitoring and logging capabilities, including VPC Flow Logs, WAF logging, CloudWatch Alarms, and security dashboards. The platform currently has basic flow log coverage but significant gaps in WAF logging and alerting that limit incident detection and forensic investigation capabilities.

### 7.1 VPC Flow Log Configuration

VPC Flow Logs are enabled on both deployment paths (new VPC and Control Tower VPC) using CDK's `addFlowLog()` method with default configuration.

**Code Evidence (New VPC path):**
```typescript
// cdk/lib/vpc-stack.ts (line 190)
this.vpc.addFlowLog("laigo-vpcFlowLog");
```

**Code Evidence (Control Tower path):**
```typescript
// cdk/lib/vpc-stack.ts (line 161)
this.vpc.addFlowLog(`${id}-vpcFlowLog`);
```

Both calls use CDK defaults with no explicit configuration parameters for traffic type, destination, format, or retention.

| Setting | Value | Assessment |
|---------|-------|------------|
| Enabled | Yes (both VPC paths) | ✅ Flow logging is active |
| Traffic Type | ALL (CDK default) | ✅ Captures both ACCEPT and REJECT traffic |
| Destination | CloudWatch Logs (CDK default) | ⚠️ Adequate for real-time queries but expensive at scale; S3 preferred for long-term archival |
| Format | Default AWS format (v2) | ⚠️ Missing enhanced fields — see Section 7.2 |
| Retention | CDK default (Never Expire) | ⚠️ No explicit retention set — relies on CloudWatch Logs default which never expires. While this exceeds the 90-day minimum, it creates unbounded cost growth. Should be explicitly configured to 90-365 days. |

**Key Concern:** The `addFlowLog()` method is called without any `FlowLogOptions`, meaning all settings use AWS CDK defaults. While the defaults are functional, the lack of explicit configuration means:
1. Retention is not bounded, leading to cost accumulation
2. No custom log format is specified, limiting forensic field availability
3. No log group naming convention is enforced, making cross-account log aggregation difficult

### 7.2 Flow Log Forensic Sufficiency

The AWS VPC Flow Log **default format (v2)** captures the following fields:

| Field | Captured | Forensic Value |
|-------|----------|----------------|
| Source IP (`srcaddr`) | ✅ Yes (default) | Identify source of attacks |
| Destination IP (`dstaddr`) | ✅ Yes (default) | Identify targeted resources |
| Source Port (`srcport`) | ✅ Yes (default) | Correlate with application connections |
| Destination Port (`dstport`) | ✅ Yes (default) | Identify targeted services |
| Protocol (`protocol`) | ✅ Yes (default) | TCP/UDP/ICMP classification |
| Packets (`packets`) | ✅ Yes (default) | Volume analysis |
| Bytes (`bytes`) | ✅ Yes (default) | Data exfiltration detection |
| Action (`action`) | ✅ Yes (default) | ACCEPT/REJECT correlation |
| Timestamp (`start`, `end`) | ✅ Yes (default) | Second-level granularity |
| VPC ID (`vpc-id`) | ❌ Not in default | Multi-VPC correlation |
| Subnet ID (`subnet-id`) | ❌ Not in default | Tier-level traffic analysis |
| TCP Flags (`tcp-flags`) | ❌ Not in default | SYN flood detection, connection state |
| Traffic Path (`flow-direction`) | ❌ Not in default | Ingress vs egress differentiation |
| Reject Reason (`reject-reason`) | ❌ Not in default | Security group vs NACL attribution |

**Assessment:** The default format provides basic forensic sufficiency (source/dest IP, ports, protocol, packet/byte counts, action, timestamps) but **lacks enhanced fields** that are critical for security investigations in a production legal platform:
- **TCP Flags:** Required to detect SYN flood attacks and differentiate connection establishment from data transfer
- **Subnet ID:** Required to quickly scope which tier (public, private, isolated) is affected during an incident
- **Flow Direction:** Required to distinguish inbound attacks from outbound data exfiltration
- **Reject Reason:** Required to determine whether traffic was blocked by security groups or NACLs (important when both layers are enforcing rules)

**Recommendation:** Configure a custom log format that includes all default fields plus `subnet-id`, `tcp-flags`, `flow-direction`, and `type` fields. Example:

```typescript
this.vpc.addFlowLog("laigo-vpcFlowLog", {
  trafficType: ec2.FlowLogTrafficType.ALL,
  destination: ec2.FlowLogDestination.toCloudWatchLogs(logGroup, iamRole),
  logFormat: [
    ec2.LogFormat.VERSION,
    ec2.LogFormat.ACCOUNT_ID,
    ec2.LogFormat.INTERFACE_ID,
    ec2.LogFormat.SRC_ADDR,
    ec2.LogFormat.DST_ADDR,
    ec2.LogFormat.SRC_PORT,
    ec2.LogFormat.DST_PORT,
    ec2.LogFormat.PROTOCOL,
    ec2.LogFormat.PACKETS,
    ec2.LogFormat.BYTES,
    ec2.LogFormat.START_TIMESTAMP,
    ec2.LogFormat.END_TIMESTAMP,
    ec2.LogFormat.ACTION,
    ec2.LogFormat.LOG_STATUS,
    ec2.LogFormat.VPC_ID,
    ec2.LogFormat.SUBNET_ID,
    ec2.LogFormat.TCP_FLAGS,
    ec2.LogFormat.FLOW_DIRECTION,
  ],
});
```

### 7.3 WAF Logging Assessment

| WAF ACL | Logging Enabled | Destination | Retention | Assessment |
|---------|-----------------|-------------|-----------|------------|
| CloudFront WAF (`waf-stack.ts`) | ❌ **No** | N/A | N/A | **Critical gap — no request logging whatsoever** |
| API Gateway WAF (`api-stack.ts`) | ❌ **No** | N/A | N/A | **Critical gap — no request logging whatsoever** |

**Code Evidence — CloudFront WAF (waf-stack.ts):**

The `WafStack` class creates a `CfnWebACL` and associates it with Amplify but contains **no** `CfnLoggingConfiguration` resource. The only observability comes from CloudWatch metrics via `cloudWatchMetricsEnabled: true` in the visibility config, which provides aggregate counts only (not per-request detail).

```typescript
// waf-stack.ts — complete WAF definition has no logging configuration
const webAcl = new wafv2.CfnWebACL(this, `${id}-cloudfront-waf`, {
  // ... rules defined ...
  visibilityConfig: {
    sampledRequestsEnabled: true,       // Only samples, not full logs
    cloudWatchMetricsEnabled: true,     // Aggregate metrics only
    metricName: "CloudFront-WAF",
  },
});
// No CfnLoggingConfiguration exists
```

**Code Evidence — API Gateway WAF (api-stack.ts):**

Similarly, the regional WAF inline in `api-stack.ts` defines `cloudWatchMetricsEnabled: true` for metrics but has **no** `CfnLoggingConfiguration` resource for full request logging.

```typescript
// api-stack.ts — WAF definition with metrics but no logging
const waf = new wafv2.CfnWebACL(this, `${id}-waf`, {
  visibilityConfig: {
    sampledRequestsEnabled: true,       // Only samples, not full logs
    cloudWatchMetricsEnabled: true,     // Aggregate metrics only
    metricName: "DFO-firewall",
  },
});
// No CfnLoggingConfiguration exists
```

**Impact of Missing WAF Logging:**
- Cannot investigate which specific requests triggered WAF rules
- Cannot analyze attack patterns, payloads, or attacker behavior
- Cannot tune false-positive thresholds based on actual blocked requests
- Cannot meet incident response forensic requirements for legal compliance
- Sampled requests in WAF console retain only 3 hours of data (insufficient for investigation)

### 7.4 Missing Logging Gaps

The following logging gaps are flagged as high-priority findings:

| Gap | Impact | Priority |
|-----|--------|----------|
| No WAF logging on CloudFront WAF | Cannot investigate frontend attacks, bot patterns, or rate-limit triggers | **High** |
| No WAF logging on API Gateway WAF | Cannot investigate API-layer attacks, SQL injection attempts, or per-user rate limit blocks | **High** |
| VPC Flow Log uses default format | Missing TCP flags, subnet ID, and flow direction limits forensic depth | **Medium** |
| No explicit Flow Log retention policy | Unbounded cost growth; no guarantee of data availability after organizational policy changes | **Medium** |

### 7.5 CloudWatch Alarms for Network Anomalies

**Assessment: No CloudWatch Alarms exist for network anomalies.**

A comprehensive search of all CDK stack files (`cdk/lib/*.ts`) found:
- **Zero** `cloudwatch.Alarm` or `CfnAlarm` resources
- **Zero** SNS topics for alert notification delivery
- **Zero** metric filters on VPC Flow Log log groups
- **Zero** anomaly detection configurations

The only monitoring-related configuration found across the entire infrastructure:
- RDS Enhanced Monitoring at 60-second intervals (`database-stack.ts`, line 149) — this monitors database OS-level metrics, not network traffic
- API Gateway CloudWatch metrics enabled (`metricsEnabled: true`) — this generates metrics but no alarms consume them
- WAF CloudWatch metrics enabled (`cloudWatchMetricsEnabled: true`) — same situation: metrics are emitted but never alerted on

**Existing Metrics Available (Not Alarmed):**

| Metric Source | Available Metrics | Alarm Configured |
|---------------|-------------------|------------------|
| API Gateway WAF | `DFO-firewall` (AllowedRequests, BlockedRequests, CountedRequests) | ❌ No |
| API Gateway WAF | `LimitRequests2000` (rate limit triggers) | ❌ No |
| API Gateway WAF | `PerUserRateLimit` (per-user blocks) | ❌ No |
| API Gateway WAF | `AWS-AWSManagedRulesCommonRuleSet` (managed rule matches) | ❌ No |
| CloudFront WAF | `CloudFront-WAF` (AllowedRequests, BlockedRequests) | ❌ No |
| CloudFront WAF | `LimitRequests1000-CloudFront` (rate limit triggers) | ❌ No |
| API Gateway | `4XXError`, `5XXError`, `Count`, `Latency` | ❌ No |
| NAT Gateway | `PacketsDropCount`, `ErrorPortAllocation`, `ActiveConnectionCount` | ❌ No |
| VPC Flow Logs | Requires metric filters on log group | ❌ No metric filters exist |

**Risk:** Without alarms, the team has no automated notification of:
- Active DDoS attacks (detected only when users report outages)
- Brute-force authentication attempts (visible only in retrospective log review)
- Data exfiltration via high outbound byte counts (undetected)
- NAT Gateway exhaustion (discovered only when Lambda functions timeout)
- WAF rate limit activations (no visibility into whether legitimate users are blocked)

### 7.6 Recommended Monitoring Alert Set

The following minimum alert set should be implemented via CloudWatch Alarms with SNS notification to the operations team:

#### Category 1: WAF Attack Detection (Priority: High)

| Alarm | Metric | Threshold | Period | Rationale |
|-------|--------|-----------|--------|-----------|
| WAF CloudFront Blocked Spike | `CloudFront-WAF` → `BlockedRequests` | > 50 in 5 min | 5 min | Indicates active attack on frontend |
| WAF API Gateway Blocked Spike | `DFO-firewall` → `BlockedRequests` | > 100 in 5 min | 5 min | Indicates active attack on API |
| Rate Limit IP Triggers (CF) | `LimitRequests1000-CloudFront` → `BlockedRequests` | > 10 in 5 min | 5 min | Multiple IPs hitting rate limit = coordinated attack |
| Rate Limit IP Triggers (API) | `LimitRequests2000` → `BlockedRequests` | > 10 in 5 min | 5 min | Same as above for API layer |
| Per-User Rate Limit Triggers | `PerUserRateLimit` → `BlockedRequests` | > 5 in 5 min | 5 min | Multiple users blocked = possible credential stuffing |

#### Category 2: VPC Flow Log Anomalies (Priority: High)

| Alarm | Source | Threshold | Period | Rationale |
|-------|--------|-----------|--------|-----------|
| Rejected Connection Spike | Flow Log metric filter (action=REJECT) | > 100 rejects in 5 min | 5 min | Port scanning or misconfigured security groups |
| High Outbound Bytes (Isolated Subnet) | Flow Log metric filter (subnet + bytes + direction) | > 1 GB in 15 min | 15 min | Potential data exfiltration from database tier |
| Unexpected Port 5432 Source | Flow Log metric filter (dstport=5432, src ≠ known Lambda SGs) | > 0 in 5 min | 5 min | Unauthorized database access attempt |

#### Category 3: NAT Gateway Health (Priority: Medium)

| Alarm | Metric | Threshold | Period | Rationale |
|-------|--------|-----------|--------|-----------|
| NAT Packets Dropped | `NATGateway` → `PacketsDropCount` | > 0 in 1 min | 1 min | Immediate: indicates capacity exhaustion |
| NAT Port Allocation Errors | `NATGateway` → `ErrorPortAllocation` | > 0 in 5 min | 5 min | Port exhaustion blocks new connections |
| NAT Active Connections High | `NATGateway` → `ActiveConnectionCount` | > 50,000 | 5 min | Approaching 55,000 concurrent connection limit |

#### Category 4: API Gateway Health (Priority: Medium)

| Alarm | Metric | Threshold | Period | Rationale |
|-------|--------|-----------|--------|-----------|
| API 4XX Error Spike | `ApiGateway` → `4XXError` | > 20% of requests | 5 min | Possible auth bypass attempts or broken clients |
| API 5XX Error Spike | `ApiGateway` → `5XXError` | > 5% of requests | 5 min | Backend failures indicating possible attack impact |
| API Latency P99 High | `ApiGateway` → `Latency` (p99) | > 10,000 ms | 5 min | Possible resource exhaustion attack |

**Implementation Reference:**

```typescript
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';

// Create SNS topic for security alerts
const securityAlertsTopic = new sns.Topic(this, 'SecurityAlertsTopic', {
  topicName: `${id}-security-alerts`,
});

// WAF Blocked Requests Alarm (API Gateway)
new cloudwatch.Alarm(this, 'WafApiBlockedSpike', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/WAFV2',
    metricName: 'BlockedRequests',
    dimensionsMap: {
      WebACL: waf.attrId,
      Region: this.region,
      Rule: 'ALL',
    },
    statistic: 'Sum',
    period: cdk.Duration.minutes(5),
  }),
  threshold: 100,
  evaluationPeriods: 1,
  alarmDescription: 'WAF API Gateway blocked request spike - possible active attack',
});
```

### 7.7 Security Dashboard Recommendation

**Assessment: No centralized security monitoring dashboard exists.**

A search of all CDK stack files confirmed no `cloudwatch.Dashboard` or `CfnDashboard` resources are defined. Operations staff have no single-pane-of-glass view into the platform's security posture.

**Recommended CloudWatch Dashboard Configuration:**

The dashboard should be defined in CDK and include the following widgets organized by security domain:

| Widget | Source | Visualization | Purpose |
|--------|--------|---------------|---------|
| Total Requests per WAF | WAF metrics (both ACLs) | Line graph, 5-min granularity | Baseline traffic patterns |
| Blocked Requests per WAF Rule | WAF metrics per rule | Stacked area chart | Identify which rules are active |
| VPC Flow Log Rejected Traffic | Flow Log metric filter | Line graph | Detect scanning/probing |
| Top Blocked IPs | WAF sampled requests | Table (top 10) | Identify repeat offenders |
| Rate Limit Activations | `LimitRequests1000-CloudFront`, `LimitRequests2000`, `PerUserRateLimit` | Number widgets | At-a-glance rate limit health |
| NAT Gateway Connections | NAT metrics | Line graph + threshold annotation | Capacity planning |
| NAT Gateway Packets Dropped | `PacketsDropCount` | Number (alarmed) | Immediate visibility of drops |
| API Gateway 4XX/5XX Rates | API Gateway metrics | Line graph with percentage | Error rate trends |
| API Gateway Latency P50/P99 | API Gateway metrics | Line graph | Performance degradation detection |
| RDS Connection Count | RDS/Enhanced Monitoring | Line graph | Database tier health |

**Implementation Effort:** Low — a CloudWatch Dashboard in CDK is a single construct with widget definitions. Estimated 2-4 hours including metric filter setup.

```typescript
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

const securityDashboard = new cloudwatch.Dashboard(this, 'SecurityDashboard', {
  dashboardName: `${id}-security-monitoring`,
  periodOverride: cloudwatch.PeriodOverride.AUTO,
  widgets: [
    [
      new cloudwatch.GraphWidget({
        title: 'WAF Blocked Requests',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/WAFV2',
            metricName: 'BlockedRequests',
            dimensionsMap: { WebACL: 'CloudFront-WAF', Rule: 'ALL' },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          // ... API Gateway WAF metric
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Rate Limit Blocks (Last Hour)',
        metrics: [/* rate limit metrics */],
        period: cdk.Duration.hours(1),
      }),
    ],
    // ... additional rows for Flow Logs, NAT, API Gateway
  ],
});
```

### Findings

| ID | Title | Severity | Effort | Status |
|----|-------|----------|--------|--------|
| NW-H1 | No WAF logging on CloudFront or API Gateway WAFs | High | Low | New |
| NW-H2 | No CloudWatch Alarms for network security anomalies | High | Low | New |
| NW-M1 | VPC Flow Log uses default format missing critical forensic fields | Medium | Low | New |
| NW-M2 | No centralized security monitoring dashboard | Medium | Low | New |
| NW-M3 | VPC Flow Log retention not explicitly configured (unbounded cost) | Medium | Low | New |

---

### Finding Details

#### NW-H1: No WAF logging on CloudFront or API Gateway WAFs

- **Severity:** High
- **Section:** 7. Network Monitoring Assessment
- **Current State:** Both WAF Web ACLs (`waf-stack.ts` CloudFront-scoped and `api-stack.ts` Regional-scoped) have `cloudWatchMetricsEnabled: true` and `sampledRequestsEnabled: true` but no `CfnLoggingConfiguration` resource. Only aggregate metrics and 3-hour sampled requests are available.
- **Gap:** Full request-level WAF logging is not configured on either WAF ACL. Without logging, the team cannot:
  - Investigate specific blocked requests to tune false positives
  - Analyze attack payloads for threat intelligence
  - Correlate WAF events with application-layer incidents
  - Meet forensic data retention requirements (90-day minimum)
- **Risk:** During an active attack or security incident, investigators have no access to the request details (URI, headers, source IP, matched rule, action taken) needed to understand the attack vector, scope the breach, or provide evidence for legal/compliance reporting. The 3-hour sampled request window in the AWS Console is insufficient for any investigation started more than a few hours after an event.
- **Recommendation:** Add `CfnLoggingConfiguration` to both WAF ACLs with CloudWatch Logs as the destination (required naming prefix: `aws-waf-logs-*`). Set log group retention to 90 days minimum.
  ```typescript
  // In waf-stack.ts
  const wafLogGroup = new logs.LogGroup(this, 'WafCfLogGroup', {
    logGroupName: `aws-waf-logs-${id}-cloudfront`,
    retention: logs.RetentionDays.THREE_MONTHS,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  new wafv2.CfnLoggingConfiguration(this, 'WafCfLogging', {
    resourceArn: webAcl.attrArn,
    logDestinationConfigs: [wafLogGroup.logGroupArn],
  });
  ```
  Repeat similarly for the API Gateway WAF in `api-stack.ts`.
- **Effort:** Low (CDK configuration change, ~2 hours including both ACLs)
- **Cross-References:** Section 4 finding NW-H1 (WAF CloudFront Assessment also flagged this), Section 5 finding regarding WAF API Gateway logging gap
- **Status:** New

---

#### NW-H2: No CloudWatch Alarms for network security anomalies

- **Severity:** High
- **Section:** 7. Network Monitoring Assessment
- **Current State:** Zero CloudWatch Alarms, zero SNS topics, zero metric filters exist across all CDK stack definitions. WAF metrics are emitted (`cloudWatchMetricsEnabled: true` on all rules) but are never consumed by alarms. API Gateway metrics are enabled (`metricsEnabled: true`) but similarly unmonitored.
- **Gap:** The platform has no automated detection or notification for:
  - DDoS attacks (WAF block spikes)
  - Brute-force attempts (per-user rate limit triggers)
  - Network scanning (VPC Flow Log reject spikes)
  - NAT Gateway failures (packet drops, port exhaustion)
  - API layer degradation (5XX spikes, latency increases)
- **Risk:** Security incidents go undetected until users report service degradation. Mean Time to Detect (MTTD) is measured in hours or days rather than minutes. For a legal platform handling privileged content, delayed breach detection compounds regulatory exposure and client notification obligations.
- **Recommendation:** Implement the minimum alert set defined in Section 7.6 covering four categories: WAF attack detection, VPC Flow Log anomalies, NAT Gateway health, and API Gateway health. Create an SNS topic for security alerts with email/Slack subscription for the operations team.
- **Effort:** Low (CDK configuration, ~4 hours for core alarm set; metric filters for Flow Logs add ~2 hours)
- **Cross-References:** None (new finding)
- **Status:** New

---

#### NW-M1: VPC Flow Log uses default format missing critical forensic fields

- **Severity:** Medium
- **Section:** 7. Network Monitoring Assessment
- **Current State:** `this.vpc.addFlowLog("laigo-vpcFlowLog")` is called without `FlowLogOptions`, resulting in AWS default format v2 which includes: version, account-id, interface-id, srcaddr, dstaddr, srcport, dstport, protocol, packets, bytes, start, end, action, log-status.
- **Gap:** The default format omits fields critical for security investigations:
  - `tcp-flags`: Cannot detect SYN flood attacks or differentiate connection phases
  - `subnet-id`: Cannot quickly scope which network tier is under attack
  - `flow-direction`: Cannot distinguish inbound attacks from outbound data exfiltration
  - `vpc-id`: Cannot correlate in multi-VPC environments
- **Risk:** During a forensic investigation, analysts must make additional API calls or cross-reference ENI IDs with subnet mappings manually, increasing investigation time. SYN flood attacks cannot be distinguished from legitimate connection attempts in the flow data.
- **Recommendation:** Configure explicit custom log format including enhanced fields (see Section 7.2 code example). This is a zero-downtime change — the existing flow log can be replaced with the enhanced version.
- **Effort:** Low (single CDK parameter change, no application impact)
- **Cross-References:** None (new finding)
- **Status:** New

---

#### NW-M2: No centralized security monitoring dashboard

- **Severity:** Medium
- **Section:** 7. Network Monitoring Assessment
- **Current State:** No `cloudwatch.Dashboard` or `CfnDashboard` resources exist in any CDK stack. Operations and security personnel must navigate between multiple AWS console pages (WAF, VPC, API Gateway, CloudWatch Metrics) to assess the platform's security posture.
- **Gap:** No single-pane-of-glass view exists for:
  - Real-time WAF effectiveness (blocked vs allowed traffic per rule)
  - VPC Flow Log rejected traffic trends
  - NAT Gateway health and capacity
  - API Gateway error rates and latency
  - Top talker IPs across WAF and Flow Logs
- **Risk:** Slower incident response due to context-switching between console pages. Security trends (gradual increase in blocked traffic indicating reconnaissance phase) go unnoticed without consolidated visualization. New team members lack a starting point for understanding the platform's network behavior.
- **Recommendation:** Implement a CloudWatch Dashboard as described in Section 7.7 with widgets covering WAF metrics, Flow Log trends, NAT health, and API Gateway performance. Estimated implementation: 2-4 hours.
- **Effort:** Low (CDK construct definition, no infrastructure changes)
- **Cross-References:** None (new finding)
- **Status:** New

---

#### NW-M3: VPC Flow Log retention not explicitly configured

- **Severity:** Medium
- **Section:** 7. Network Monitoring Assessment
- **Current State:** `addFlowLog()` is called without specifying a log group or retention policy. CDK creates a CloudWatch Logs log group with default retention of "Never Expire."
- **Gap:** While "never expire" technically exceeds the 90-day forensic retention requirement, it creates two operational issues:
  1. **Unbounded cost growth:** Flow Log data accumulates indefinitely, with no lifecycle policy to transition old data to cheaper storage or delete it after compliance periods expire
  2. **Implicit vs explicit policy:** If the organization changes its CloudWatch Logs default retention settings at the account level, flow log data could be unexpectedly deleted
- **Risk:** Flow Log storage costs grow linearly over time with no natural ceiling. For a VPC with moderate traffic, this can reach $50-100/month within a year. Additionally, relying on implicit defaults rather than explicit retention settings means the forensic data guarantee is fragile.
- **Recommendation:** Create an explicit `logs.LogGroup` with `RetentionDays.THREE_MONTHS` (90 days) or `RetentionDays.ONE_YEAR` (365 days) depending on compliance requirements, and pass it to `addFlowLog()`:
  ```typescript
  const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
    logGroupName: `/vpc/flow-logs/${id}`,
    retention: logs.RetentionDays.THREE_MONTHS,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  this.vpc.addFlowLog("laigo-vpcFlowLog", {
    destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
    trafficType: ec2.FlowLogTrafficType.ALL,
  });
  ```
- **Effort:** Low (CDK configuration change)
- **Cross-References:** None (new finding)
- **Status:** New

---

## 8. API Gateway Security Assessment

> *Requirement 7: Document API Gateway Security Configuration Assessment*

This section assesses API Gateway security settings beyond WAF: throttling, request validation, access controls, data trace compliance risk, and WebSocket API security configuration.

### 8.1 Stage Throttling Assessment

**Current Configuration** (`cdk/lib/api-stack.ts`):
```typescript
methodOptions: {
  "/*/*": {
    throttlingRateLimit: 100,   // 100 requests per second
    throttlingBurstLimit: 200,  // 200 concurrent requests
  },
},
```

**Assessment:**

- **Rate limit (100 req/s):** For a legal education platform serving Canadian law students, supervisors, and admins, expected peak concurrent users is estimated at 50–200 (class of students accessing simultaneously during lab sessions). At 100 req/s, the platform allows approximately 0.5–2 requests/second/user during peak, which is sufficient for typical SPA interactions (page loads, API calls).
- **Burst limit (200):** The burst limit at 2× the rate limit provides adequate headroom for coordinated page loads (e.g., all students opening their case dashboard simultaneously at the start of a class). This meets the 2× expected peak threshold.
- **Ratio analysis:** With 200 peak concurrent users each generating ~0.3 req/s during normal use = ~60 req/s expected peak. The 100 req/s rate limit provides ~1.67× headroom (marginally below the recommended 1.5× threshold but acceptable given burst capacity). The burst limit of 200 provides comfortable headroom for spikes.
- **WebSocket stage throttle alignment:** The WebSocket API (`wsStage`) also uses 100 req/s rate and 200 burst, providing consistent throttling across both APIs.

**Assessment: Adequate for current scale.** The 100/200 configuration is reasonable for a legal education platform. However, if the platform scales to multiple institutions, these limits may need per-route or per-method customization.

### 8.2 Request Validation Configuration

**Current Configuration** (`cdk/OpenAPI_Swagger_Definition.yaml`):
```yaml
x-amazon-apigateway-request-validators:
  all:
    validateRequestParameters: true
    validateRequestBody: true
  params-only:
    validateRequestParameters": true
    validateRequestBody": false
x-amazon-apigateway-request-validator: params-only
```

**Assessment:**

1. **Global default is `params-only`:** The API-wide default validator only validates request parameters (query strings, path parameters, headers) but does NOT validate request bodies. This means JSON payloads are forwarded to Lambda without schema validation at the gateway level.

2. **Configuration syntax error detected:** The `params-only` validator definition contains incorrect quotes in key names (`validateRequestParameters"` and `validateRequestBody"` — note trailing double-quote in key names). This is likely a YAML syntax issue that may cause the validator to be silently ignored, meaning no validation occurs at all.

3. **Endpoints lacking body validation:** Since the global default is `params-only` and no individual endpoints override to the `all` validator, **all POST/PUT/DELETE endpoints rely entirely on Lambda-level validation** for request body schema enforcement. This includes:
   - `POST /admin/prompt` (system prompt creation)
   - `POST /admin/ai_config` (AI model configuration)
   - `PUT /admin/user_role` (role changes)
   - `POST /student/case_page` (case creation)
   - All other endpoints accepting request bodies

4. **Defense-in-depth gap:** Without gateway-level body validation, malformed or oversized JSON payloads reach Lambda functions, consuming compute time before validation rejects them. This creates unnecessary cost and latency exposure.

### 8.3 dataTraceEnabled Compliance Risk

**Current Configuration** (`cdk/lib/api-stack.ts`):
```typescript
deployOptions: {
  stageName: "prod",
  loggingLevel: apigateway.MethodLoggingLevel.ERROR,
  dataTraceEnabled: true,  // ⚠️ Logs full request/response bodies
  metricsEnabled: true,
  // ...
}
```

**Assessment:**

`dataTraceEnabled: true` causes API Gateway to log **full request and response bodies** to CloudWatch Logs for requests that result in errors. Given the platform handles:

- **Attorney-client privileged communications** (legal case discussions, AI-assisted legal analysis)
- **Legal case details** (case summaries, interview transcripts, legal arguments)
- **Personal information** (student names, emails, case participant details)

**Compliance Risks:**

| Risk Category | Impact |
|---------------|--------|
| **Attorney-client privilege** | Logged legal content may be discoverable in legal proceedings, potentially waiving privilege protections |
| **Data retention** | CloudWatch Logs retain data per the log group's retention policy (currently 1 month per `accessLogGroup`); however, execution logs use the default API Gateway log group which may have no retention limit configured |
| **Data residency** | CloudWatch Logs are stored in the deployment region; no explicit verification that this meets Canadian data residency requirements |
| **Audit exposure** | AWS support staff with CloudWatch access can view privileged legal content during support cases |
| **PIPEDA compliance** | Canadian privacy law requires purpose limitation — logging full bodies for debugging exceeds the stated purpose of error diagnostics |

**Mitigating factor:** `loggingLevel: ERROR` means data trace only applies to error responses, not all requests. However, any request that triggers a Lambda error, timeout, or 5xx response will have its full body logged.

### 8.4 Authentication and Authorization Flow

**Current Architecture:**

```
Client → API Gateway → Lambda Authorizer → Lambda Handler
                              ↓
                    1. Verify JWT (Cognito ID token)
                    2. Extract sub claim (idpId)
                    3. Query DB for userId + roles
                    4. Enforce role membership
                    5. Return IAM policy + context
```

**Three separate Lambda authorizers enforce role-based access:**
- `adminLambdaAuthorizer` → enforces `admin` role → scopes policy to `/*/admin/*`
- `instructorLambdaAuthorizer` → enforces `instructor` role → scopes policy to `/*/instructor/*`
- `studentLambdaAuthorizer` → enforces `student` role (with shared route exceptions) → scopes policy to `/*/student/*`

**Authorizer caching:** All three authorizers have `authorizerResultTtlInSeconds: 60`, meaning a valid policy is cached for 60 seconds per token. This is appropriately short to limit stale-role risk while reducing cold-start latency impact.

**Routes bypassing Lambda authorizer enforcement:**

| Route Pattern | Auth Status | Mechanism | Risk |
|---------------|-------------|-----------|------|
| `OPTIONS /*` (all paths) | **Unauthenticated** | MOCK integration (no Lambda invocation) | **Acceptable** — CORS preflight by spec must not require auth |
| `/admin/health` | **Authenticated** | Uses `adminAuthorizer` | No bypass |
| `/instructor/health` | **Authenticated** | Uses `instructorAuthorizer` | No bypass |
| `/student/health` | **Authenticated** | Uses `studentAuthorizer` | No bypass |

**Positive finding:** All health-check endpoints require their respective authorizers. There are no publicly accessible unauthenticated REST endpoints beyond OPTIONS preflight.

**Student authorizer shared-route pattern:**
The student authorizer permits non-student authenticated users to access specific routes:
- `GET /student/profile`, `GET /student/role_labels`, `GET /student/get_disclaimer`, `POST /student/accept_disclaimer` — accessible to any authenticated user
- Case-detail routes (`GET /student/case_page`, etc.) — accessible to instructors for case oversight

This is a deliberate design decision documented in code comments and is appropriate for the supervisor-advocate relationship model.

**WebSocket authorizer:**
The `wsAuthorizer` validates the JWT token from the `Sec-WebSocket-Protocol` header, queries the database for user metadata, but does **not** enforce role membership (unlike REST authorizers). It authenticates any valid user regardless of role. Role-based authorization is deferred to WebSocket message handlers.

### 8.5 mTLS and API Keys Assessment

**Current authentication layers:**
1. **Cognito User Pool** — user registration, email verification, password policy (12+ chars, complexity requirements)
2. **JWT verification** — `aws-jwt-verify` library validates token signature, expiration, audience, issuer
3. **Database role lookup** — authorizer resolves JWT `sub` to internal userId and verifies role membership
4. **IAM policy scoping** — generated policy restricts access to role-specific path patterns

**Threat model evaluation:**

| Threat | Current Mitigation | mTLS/API Key Benefit |
|--------|-------------------|---------------------|
| Token theft (XSS) | 30-minute token expiry, HttpOnly cookies via Amplify SDK | mTLS would add device binding |
| Credential stuffing | Cognito password policy + account lockout | API keys would add defense layer |
| Insider access | Role enforcement via DB lookup | N/A |
| Token replay | Short TTL (30 min), authorizer cache TTL 60s | mTLS would prevent replay from different device |
| API enumeration | Authorizer blocks unauthorized roles | API key would prevent unauthenticated scanning |

**Recommendation:**

- **mTLS:** Not warranted for current threat model. The platform serves web-browser clients where mTLS certificate management creates significant UX friction. Cognito JWT + Lambda authorizer provides sufficient authentication for a legal education platform.
- **API keys:** Not recommended as a security control (AWS documentation explicitly states API keys are for usage tracking, not authentication). The existing Cognito + authorizer chain provides stronger identity verification than API keys.
- **Future consideration:** If the platform expands to B2B API integrations (e.g., LMS integration), mTLS or OAuth2 client credentials should be evaluated for service-to-service authentication.

### 8.6 WebSocket API Security

**Current Configuration** (`cdk/lib/api-stack.ts`):

```typescript
// WebSocket API
this.wsApi = new apigwv2.WebSocketApi(this, `${id}-ChatWebSocketApi`, {
  apiName: `${id}-ChatWebSocket`,
  connectRouteOptions: {
    integration: new WebSocketLambdaIntegration("ConnectIntegration", wsConnectFunction),
    authorizer: wsAuthorizer,  // Lambda authorizer on $connect
  },
  disconnectRouteOptions: { /* ... */ },
  defaultRouteOptions: { /* ... */ },
});

// Stage throttling
this.wsStage = new apigwv2.WebSocketStage(this, `${id}-WsStage`, {
  webSocketApi: this.wsApi,
  stageName: "prod",
  autoDeploy: true,
  throttle: {
    rateLimit: 100,   // 100 requests per second
    burstLimit: 200,  // Allow bursts up to 200
  },
});
```

**Security controls assessment:**

| Control | Configuration | Assessment |
|---------|--------------|------------|
| **Authorization** | `wsAuthorizer` Lambda on `$connect` route | ✅ Validates JWT, queries DB for userId/metadata |
| **Stage throttling** | 100 req/s, 200 burst | ✅ Consistent with REST API limits |
| **Connection limit** | 5 per user (`MAX_CONNECTIONS_PER_USER`) | ✅ Prevents connection exhaustion per user |
| **Connection TTL** | 2 hours (`ttl` in DynamoDB) | ⚠️ DynamoDB TTL is the *only* mechanism for stale connection cleanup |
| **Idle timeout** | API Gateway default: 10 minutes | ⚠️ Not explicitly configured; relies on AWS default |
| **Max connection duration** | Not configured (AWS default: 2 hours) | ⚠️ Matches DynamoDB TTL but not explicitly enforced |
| **WAF protection** | **None** — WebSocket API has no WAF association | ⚠️ Assessed separately in Section 5 |

**Stale connection handling:**

The current implementation relies on:
1. **DynamoDB TTL (2 hours):** Connection records auto-expire, but this doesn't actively close the WebSocket connection — it only removes the tracking record
2. **API Gateway idle timeout (10 min default):** AWS automatically closes connections with no message activity for 10 minutes
3. **Client-side heartbeat:** The `$default` route handler processes ping/pong messages (implied by `wsDefaultFunction` architecture)

**Gap:** There is no server-side mechanism to actively terminate connections that exceed maximum duration. If a client maintains activity (sending periodic pings), the connection can persist indefinitely until the 2-hour API Gateway hard limit. The DynamoDB TTL removes the record but does not invoke `@connections/{connectionId}` DELETE to force-close the socket.

**Identity source configuration:**
```typescript
const wsAuthorizer = new WebSocketLambdaAuthorizer(`${id}-WsAuthorizer`, wsAuthorizerFunction, {
  identitySource: ["route.request.header.Sec-WebSocket-Protocol"],
});
```

The token is passed via the `Sec-WebSocket-Protocol` header — this is a well-known pattern for browser WebSocket clients that cannot set custom headers. The authorizer also checks `Authorization` header and `token` query parameter as fallbacks, providing flexibility for non-browser clients.

### Findings

| ID | Title | Severity | Effort | Status |
|----|-------|----------|--------|--------|
| NW-H5 | `dataTraceEnabled: true` logs privileged legal content to CloudWatch | High | Low | New |
| NW-M7 | Request body validation not enforced at API Gateway level | Medium | Medium | New |
| NW-M8 | OpenAPI validator definition has syntax errors in key names | Medium | Low | New |
| NW-M9 | WebSocket API lacks active stale connection termination | Medium | Medium | New |
| NW-L3 | WebSocket idle timeout and max duration rely on AWS defaults | Low | Low | New |

---

#### NW-H5: `dataTraceEnabled: true` Logs Privileged Legal Content to CloudWatch

**Severity:** High  
**Section:** API Gateway Security Assessment  

**Current State:**
```typescript
// cdk/lib/api-stack.ts
deployOptions: {
  loggingLevel: apigateway.MethodLoggingLevel.ERROR,
  dataTraceEnabled: true,  // Logs full request/response bodies on errors
}
```

**Gap:** Full request and response bodies containing attorney-client privileged legal content (case discussions, legal analysis, AI-generated summaries) are logged to CloudWatch when API errors occur. This creates an uncontrolled repository of privileged content outside the application's data governance boundary.

**Risk:** Privileged legal communications stored in CloudWatch Logs may be discoverable in legal proceedings, potentially waiving attorney-client privilege. CloudWatch log retention may exceed data retention policies. AWS support personnel with account access could view privileged content. Violates purpose limitation under PIPEDA (Canadian privacy law) — debugging logs should not contain full privileged content.

**Recommendation:** Set `dataTraceEnabled: false` in production. Retain structured access logs (already configured via `accessLogFormat`) which capture request metadata without body content. For debugging, enable data trace temporarily in development/staging environments only.

```typescript
deployOptions: {
  dataTraceEnabled: isProd ? false : true,  // Never log bodies in production
}
```

**Effort:** Low  
**Cross-References:** Related to data retention policies in Bedrock logging configuration  
**Status:** New

---

#### NW-M7: Request Body Validation Not Enforced at API Gateway Level

**Severity:** Medium  
**Section:** API Gateway Security Assessment  

**Current State:**
```yaml
# cdk/OpenAPI_Swagger_Definition.yaml
x-amazon-apigateway-request-validator: params-only
```

The global default validator is `params-only`, which only validates query parameters and headers. No individual endpoint overrides to the `all` validator for body validation.

**Gap:** All POST/PUT/DELETE endpoints forward raw JSON payloads to Lambda without gateway-level schema validation. Malformed, oversized, or unexpected JSON structures are processed by Lambda compute before application-level validation rejects them.

**Risk:** Increased Lambda invocation costs from processing invalid payloads that could be rejected at the gateway level. Larger attack surface for JSON-based injection attempts. Missing defense-in-depth — if Lambda validation has a bug, no gateway-level backstop exists.

**Recommendation:** For critical mutation endpoints (role changes, AI configuration, prompt management), add request body models in the OpenAPI spec and override to the `all` validator:
```yaml
/admin/user_role:
  put:
    x-amazon-apigateway-request-validator: all
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/UserRoleUpdate'
```

Prioritize endpoints that modify security-sensitive state: `/admin/user_role`, `/admin/ai_config`, `/admin/elevate_instructor`.

**Effort:** Medium (requires defining JSON schemas for each endpoint in OpenAPI spec)  
**Cross-References:** —  
**Status:** New

---

#### NW-M8: OpenAPI Validator Definition Has Syntax Errors in Key Names

**Severity:** Medium  
**Section:** API Gateway Security Assessment  

**Current State:**
```yaml
# cdk/OpenAPI_Swagger_Definition.yaml
x-amazon-apigateway-request-validators:
  params-only:
    validateRequestParameters": true   # ← trailing quote in key name
    validateRequestBody": false        # ← trailing quote in key name
```

**Gap:** The `params-only` validator definition has trailing double-quote characters embedded in the YAML key names (`validateRequestParameters"` instead of `validateRequestParameters`). This is syntactically valid YAML (the quotes are part of the key string) but **does not match the API Gateway schema** for request validators. API Gateway expects exact key names without extra characters.

**Risk:** The `params-only` validator may be silently ignored by API Gateway, resulting in **no request parameter validation** occurring at all. This means required query parameters and path parameters are not validated at the gateway level, allowing requests with missing required parameters to reach Lambda.

**Recommendation:** Fix the validator key names:
```yaml
x-amazon-apigateway-request-validators:
  all:
    validateRequestParameters: true
    validateRequestBody: true
  params-only:
    validateRequestParameters: true
    validateRequestBody: false
```

**Effort:** Low (single-line fix in OpenAPI spec)  
**Cross-References:** —  
**Status:** New

---

#### NW-M9: WebSocket API Lacks Active Stale Connection Termination

**Severity:** Medium  
**Section:** API Gateway Security Assessment  

**Current State:**
```typescript
// cdk/lambda/websocket/connect.js
const ttl = Math.floor(Date.now() / 1000) + 2 * 60 * 60; // 2 hours from now
```

Connection records have a 2-hour DynamoDB TTL, but no server-side mechanism actively closes WebSocket connections that exceed their intended lifetime.

**Gap:** DynamoDB TTL removes tracking records but does not invoke the API Gateway `@connections/{connectionId}` DELETE API to force-close the underlying TCP connection. Active clients sending periodic messages can maintain connections indefinitely (up to API Gateway's 2-hour hard limit). After TTL expires, the connection becomes "orphaned" — still open at the transport layer but invisible to the notification system.

**Risk:** Orphaned connections consume API Gateway concurrent connection quota. Users who revoke their session (logout, password change) may maintain an active WebSocket for up to 2 hours. Stale connections cannot receive notifications (DynamoDB record deleted) but continue consuming resources.

**Recommendation:** Implement a scheduled Lambda (EventBridge rule, every 15 minutes) that:
1. Queries connections with `connectedAt` older than the maximum duration threshold
2. Calls `DELETE @connections/{connectionId}` via the API Gateway Management API to force-close them
3. Removes the DynamoDB record

Alternatively, implement server-side ping with timeout: if no pong received within 30 seconds, force-close the connection.

**Effort:** Medium (new Lambda + EventBridge rule + API Gateway Management API integration)  
**Cross-References:** —  
**Status:** New

---

#### NW-L3: WebSocket Idle Timeout and Max Duration Rely on AWS Defaults

**Severity:** Low  
**Section:** API Gateway Security Assessment  

**Current State:**
The WebSocket stage configuration sets throttle limits but does not explicitly configure:
- Idle connection timeout (AWS default: 10 minutes)
- Maximum connection duration (AWS default: 2 hours, hard limit)

**Gap:** Reliance on AWS defaults means configuration is implicit and could change without notice. The 10-minute idle timeout is appropriate for a chat application but is not documented or enforced at the application level.

**Risk:** If AWS changes defaults, connection behavior changes without CDK deployment. No documentation of expected connection lifecycle for operations team. The 2-hour max duration is a hard AWS limit and cannot be extended, which is appropriate but should be documented for frontend client reconnection logic.

**Recommendation:** Document the expected WebSocket connection lifecycle in architecture documentation:
- Idle timeout: 10 minutes (AWS default, acceptable)
- Max duration: 2 hours (AWS hard limit)
- Client responsibility: implement automatic reconnection with exponential backoff
- DynamoDB TTL alignment: 2 hours (matches max duration)

No code change required — this is a documentation/awareness finding.

**Effort:** Low  
**Cross-References:** —  
**Status:** New

---

## 9. Cross-Cutting Findings Consolidation

> *Requirement 8: Document Cross-Cutting Networking Findings from Existing Reviews*

This section consolidates all networking-related findings from the 10 existing code review documents (`code-review-cdk-infrastructure.md`, `code-review-security.md`, `code-review-rds.md`, `code-review-well-architected.md`, `code-review-bedrock.md`, `code-review-s3-best-practices.md`, `code-review-lambda-functions.md`, `code-review-nodejs-handlers.md`, `code-review-frontend.md`, `code-review-database.md`), cross-references each finding with its current status in `REMEDIATION-STATUS.md` (last audited 2025-07-21), identifies findings warranting re-verification, discovers networking coverage gaps, and consolidates duplicate findings.

**Networking-related** is defined as findings pertaining to: VPC configuration, security groups, NAT gateways, API Gateway (REST and WebSocket) routing and throttling, CORS policies, TLS/SSL enforcement, DNS/domain configuration, network ACLs, VPC endpoints, and inter-service connectivity.

---

### 9.1 Consolidated Findings from Existing Reviews

#### 9.1.1 Open / Partial Findings (Active — Require Remediation)

| Original ID | Source Document(s) | Finding Title | Severity | Remediation Status | Network Relevance | Priority |
|-------------|-------------------|---------------|----------|-------------------|-------------------|----------|
| CDK-H4 / WA-H2 | `code-review-cdk-infrastructure.md`, `code-review-well-architected.md` | Single NAT Gateway creates AZ single point of failure | High | ⬜ Open | NAT gateway high-availability; AZ failure causes loss of all outbound internet for 13+ Lambda functions | 1 |
| RDS-H2 (Network aspect) | `code-review-rds.md`, `code-review-security.md` | VPC-wide security group rule allows entire CIDR to connect on port 5432 | High | ⬜ Open | Security group least-privilege violation; any VPC resource can reach database | 2 |
| WA-C1 / RDS-H1 | `code-review-well-architected.md`, `code-review-rds.md` | RDS Single-AZ — single point of failure (combined with NAT SPOF = total outage risk) | High | ⬜ Open | Inter-service connectivity; database layer unavailability cascades to all services | 3 |
| S-H4 / CDK-M2 | `code-review-security.md`, `code-review-cdk-infrastructure.md` | `dataTraceEnabled: true` logs full request/response bodies through API Gateway | High | ⏸ Deferred | API Gateway configuration; full legal content logged in CloudWatch violates privilege | 4 |
| Node-H3 | `code-review-nodejs-handlers.md` | WebSocket token passed via `Sec-WebSocket-Protocol` header (echoed in response) | High | ⬜ Open | WebSocket connection lifecycle security; token exposure in network logs | 5 |
| RDS-M1 | `code-review-rds.md` | RDS Proxy IAM role uses wildcard resource (`*`) for `rds-db:connect` | Medium | ⬜ Open | VPC/inter-service connectivity; over-permissioned role could connect to any RDS in account | 6 |
| WA-H1 | `code-review-well-architected.md` | No CloudWatch Alarms defined anywhere (including network metrics) | High | ⬜ Open | Network monitoring; no alerting on VPC flow log anomalies, NAT errors, or API GW throttling | 7 |
| RDS-M3 | `code-review-rds.md` | No CloudWatch Alarms for database health (connections, CPU) | Medium | ⬜ Open | Network monitoring; no visibility into connection saturation or database connectivity issues | 8 |
| WA-L4 | `code-review-well-architected.md` | VPC endpoints incur hourly charges that may not be justified for low traffic | Low | ⬜ Open | VPC endpoints; cost-benefit assessment needed for endpoint retention | 9 |
| FE-H1 | `code-review-frontend.md` | Duplicate WebSocket connections for every authenticated user | High | ⏸ Deferred | WebSocket connection lifecycle; double connections waste resources and complicate session management | 10 |

#### 9.1.2 Fixed Findings (Remediated)

| Original ID | Source Document(s) | Finding Title | Severity | Remediation Status | Network Relevance |
|-------------|-------------------|---------------|----------|-------------------|-------------------|
| S-C1 / CDK-C1 | `code-review-security.md`, `code-review-cdk-infrastructure.md` | TLS verification disabled (`NODE_TLS_REJECT_UNAUTHORIZED: "0"`) in migration Lambda | Critical | ✅ Fixed | Transport security; TLS bypass enabled MITM on RDS Proxy connections |
| S-H3 / CDK-M6 | `code-review-security.md`, `code-review-cdk-infrastructure.md` | WebSocket API has no rate limiting/throttling | High | ✅ Fixed | API Gateway throttling; stage throttle now 100 rps rate, 200 burst |
| S-H5 / CDK-M4 | `code-review-security.md`, `code-review-cdk-infrastructure.md` | S3 CORS includes `localhost:5173` in production | High | ✅ Fixed | CORS policy; localhost excluded from S3 CORS origins in production |
| S-M4 / Lambda-M4 | `code-review-security.md`, `code-review-lambda-functions.md` | CORS origin falls back to wildcard (`*`) silently when `ALLOWED_ORIGIN` unset | Medium | ✅ Fixed | CORS policy; warning now logged when fallback occurs |
| S-M5 / Lambda-H3 / Node-H1 | `code-review-security.md`, `code-review-lambda-functions.md`, `code-review-nodejs-handlers.md` | Stale database connections not detected (server-side drops) | Medium | ✅ Fixed | Inter-service connectivity; `SELECT 1` health check + reconnect implemented |
| RDS-H4 | `code-review-rds.md` | Handler connection module lacks timeout config (hang on network issues) | High | ✅ Fixed | Inter-service connectivity; `max: 1`, `idle_timeout: 20`, `connect_timeout: 10` configured |
| S3-C1 | `code-review-s3-best-practices.md` | Whitelist upload bucket missing `enforceSSL` — allows unencrypted HTTP | Critical | ✅ Fixed | TLS/SSL enforcement; `enforceSSL: true` added |
| S3-L1 | `code-review-s3-best-practices.md` | Overly permissive CORS HTTP methods (all methods allowed) | Low | ✅ Fixed | CORS policy; restricted to PUT+HEAD (whitelist) and GET+PUT+HEAD (audio) |
| S3-L2 | `code-review-s3-best-practices.md` | `allowedHeaders: ["*"]` in CORS configuration | Low | ✅ Fixed | CORS policy; restricted to `Content-Type`, `Content-Length`, `x-amz-*` |
| S3-H1 | `code-review-s3-best-practices.md` | Pre-signed URL for whitelist CSV has 1-hour expiration | High | ✅ Fixed | Inter-service connectivity; reduced to 300 seconds (5 minutes) |

---

### 9.2 Findings Warranting Re-Verification

The following Fixed findings warrant re-verification due to age, partial status in cross-references, or environment-specific configuration:

| Original ID | Finding | Reason for Re-Verification | Re-Verification Action |
|-------------|---------|---------------------------|----------------------|
| S-C1 / CDK-C1 | TLS verification disabled in migration Lambda | **Environment-specific config** — Fix applies per-connection SSL in `index.js` but the `dbFlow-stack.ts` environment variable removal must be verified in ALL deployed environments (dev, staging, prod) | Verify `NODE_TLS_REJECT_UNAUTHORIZED` is absent from ALL environment configs in deployed stacks; confirm `ssl: { rejectUnauthorized: true }` is active in `db_setup/index.js` |
| S-H5 / CDK-M4 | S3 CORS includes localhost in production | **Environment-specific config** — Fix depends on runtime evaluation of `allowedOrigin` CDK context parameter being set correctly per environment | Verify production deployment sets `DomainName` context parameter AND that the S3 CORS origins in the deployed bucket policy do NOT include `localhost:5173` |
| S-H3 / CDK-M6 | WebSocket API no throttling | **Cross-reference status discrepancy** — REMEDIATION-STATUS.md marks as ✅ Fixed, but the Security review (S-H3) was marked ⬜ Open in its own document (now stale) | Verify deployed WebSocket stage has `throttle: { rateLimit: 100, burstLimit: 200 }` active in API Gateway console |
| S-M5 / Lambda-H3 | Stale database connections | **Partial in cross-reference** — Node.js handler `initializeConnection.js` is confirmed Fixed, but Python Lambda `connect_to_db()` status shows conflict between REMEDIATION-STATUS.md (Lambda-H3: ⬜ Open) and the Security review (S-M5: ✅ Fixed) | Verify ALL Python Lambdas (text_generation, playground_generation, case_generation, summary_generation, assess_progress) include `SELECT 1` health check in `connect_to_db()` |
| S-M4 / Lambda-M4 | CORS wildcard fallback | **Environment-specific config** — Warning logging only helps if `ALLOWED_ORIGIN` is actually set in prod. If the env var is missing in a new deployment, CORS silently degrades | Verify `ALLOWED_ORIGIN` environment variable is set on ALL deployed Lambda functions (both Node.js and Python) in production |

---

### 9.3 Networking Coverage Gaps

The following networking security areas were NOT comprehensively addressed by any of the 10 existing code reviews. These represent gaps requiring assessment in this review:

**Coverage Checklist Assessment:**

| Area | Covered by Existing Reviews? | Gap Details |
|------|------------------------------|-------------|
| VPC subnet isolation | ✅ Partially (CDK, RDS reviews) | Control Tower isolation concern identified but not deeply assessed for route table behavior |
| Ingress/egress SG rules scoped to least-privilege | ✅ Partially (RDS review) | RDS ingress analyzed; **Lambda egress NOT assessed** — no review evaluated whether Lambda functions have least-privilege outbound restrictions |
| NAT gateway high-availability | ✅ Covered (CDK, WA reviews) | Single NAT Gateway identified as SPOF in multiple reviews |
| API Gateway authorization and throttling on all routes | ✅ Partially (Security review) | REST API throttling covered; **per-route throttling not assessed** — no review evaluated whether specific high-value routes (AI generation, file upload) have tighter throttling |
| WebSocket connection lifecycle security | ⚠️ Partially (Node.js, Frontend reviews) | Token handling and duplicate connections covered; **idle timeout, max connection duration, stale connection termination NOT assessed** |
| TLS enforcement on all data-in-transit paths | ✅ Partially (Security, RDS reviews) | RDS TLS well-covered; **Lambda→AWS service TLS NOT assessed** — no review verified TLS enforcement on Bedrock, Transcribe, or EventBridge connections |
| DNS failover configuration | ❌ NOT covered | **No review assessed:** Route 53 health checks, DNS failover records, custom domain TLS certificates, CloudFront origin failover configuration |

**Identified Networking Gaps Not Covered by Any Existing Review:**

1. **DNS/Domain Configuration** — No review assessed Route 53 DNS configuration, custom domain TLS certificate management, DNSSEC, or DNS failover for high availability. The platform uses Amplify-managed hosting which likely handles this, but no verification exists.

2. **Network ACL (NACL) Configuration** — No review assessed whether NACLs are configured as an additional defense layer. Default NACLs allow all traffic; no custom NACL rules were identified in any review.

3. **Lambda Egress Restrictions** — All reviews note that Lambda functions share the RDS security group with unrestricted outbound (`0.0.0.0/0` egress), but no review assessed whether egress should be restricted per function to only required destinations (e.g., text_generation → Bedrock endpoint only, not arbitrary internet hosts).

4. **VPC Flow Log Configuration and Retention** — While WA-H1 notes missing CloudWatch Alarms, no review assessed whether VPC Flow Logs are enabled, what traffic types they capture, or whether retention meets the 90-day minimum for forensics.

5. **API Gateway Mutual TLS (mTLS)** — No review assessed whether mTLS is appropriate for the threat model or evaluated API Gateway certificate configuration.

6. **CloudFront-to-Origin TLS Configuration** — No review assessed the minimum TLS version between CloudFront and the API Gateway origin, or whether origin protocol policy enforces HTTPS-only.

7. **Inter-Service Network Path Encryption** — While individual TLS settings were reviewed (RDS, Proxy), no review mapped ALL hop-by-hop encryption states (Client → CloudFront → APIGW → Lambda → RDS Proxy → RDS, and Lambda → Bedrock/Transcribe/S3/DynamoDB).

8. **WAF Logging Configuration and Retention** — No prior review assessed whether WAF logging is enabled, where logs are stored, or whether retention meets forensic investigation requirements.

---

### 9.4 Duplicate Finding Consolidation

The following findings appear in multiple source documents. They are consolidated as single entries with the highest severity classification and all source references:

| Consolidated Finding | Source Documents | Severity Used | Rationale |
|---------------------|-----------------|---------------|-----------|
| **Single NAT Gateway SPOF** | CDK-H4 (`code-review-cdk-infrastructure.md`), WA-H2 (`code-review-well-architected.md`) | **High** (consensus) | Both reviews rate as High; CDK review focuses on AZ failure, WA review adds reliability pillar context. Consolidated as NW-H1 in §2. |
| **VPC-wide CIDR security group rule** | RDS-H2 (`code-review-rds.md`), Security review network posture note (`code-review-security.md`) | **High** (from RDS review) | RDS review provides detailed assessment; Security review references it in the "Network Security" posture section. Maps to NW-H3 in §3. |
| **RDS Single-AZ** | RDS-H1 (`code-review-rds.md`), WA-C1 (`code-review-well-architected.md`) | **High** (consensus) | Reliability concern; combined with NAT SPOF creates total AZ failure scenario. Networking relevance: database connectivity unavailable. |
| **TLS verification bypass** | S-C1 (`code-review-security.md`), CDK-C1 (`code-review-cdk-infrastructure.md`) | **Critical** (consensus) | Both rate as Critical. Fixed — `NODE_TLS_REJECT_UNAUTHORIZED` removed; SSL handled per-connection. |
| **WebSocket no throttling** | S-H3 (`code-review-security.md`), CDK-M6 (`code-review-cdk-infrastructure.md`) | **High** (from Security review) | Security review escalates CDK's Medium to High due to cost amplification attack vector. Fixed — stage throttle configured. |
| **S3 CORS localhost in production** | S-H5 (`code-review-security.md`), CDK-M4 (`code-review-cdk-infrastructure.md`) | **High** (from Security review) | Security review escalates CDK's Medium to High due to cross-origin attack vector with valid credentials. Fixed. |
| **CORS wildcard fallback** | S-M4 (`code-review-security.md`), Lambda-M4 (`code-review-lambda-functions.md`), Node.js M4 implicit | **Medium** (consensus) | Same finding reported in both Python and Node.js Lambda reviews. Fixed — warning logged. |
| **Stale DB connections** | S-M5 (`code-review-security.md`), Lambda-H3 (`code-review-lambda-functions.md`), Node-H1 (`code-review-nodejs-handlers.md`) | **High** (from Lambda review) | Highest severity was High (Lambda-H3 rated High for first-request failure impact). Python fix status requires re-verification (see §9.2). |
| **dataTraceEnabled logs bodies** | S-H4 (`code-review-security.md`), CDK-M2 (`code-review-cdk-infrastructure.md`) | **High** (from Security review) | Security review rates higher than CDK review due to attorney-client privilege compliance risk. Deferred for development debugging. |
| **No CloudWatch Alarms (network metrics)** | WA-H1 (`code-review-well-architected.md`), RDS-M3 (`code-review-rds.md`) | **High** (from WA review) | WA review rates system-wide alarm absence as High; RDS review focuses specifically on database metrics (Medium). Both contribute to network monitoring gap. |

---

### 9.5 Prioritized Open/Partial Findings

The following open and partial networking findings are ranked by severity descending, then effort ascending:

| Priority | ID(s) | Finding | Severity | Effort | Status | Recommended Action |
|----------|--------|---------|----------|--------|--------|-------------------|
| 1 | CDK-H4 / WA-H2 | Single NAT Gateway SPOF | High | Low | Open | Set `natGateways: isProd ? 2 : 1` (~$32/month) |
| 2 | RDS-H2 | VPC-wide CIDR SG rule on port 5432 | High | Low | Open | Replace CIDR rule with security-group-reference rule |
| 3 | WA-H1 | No CloudWatch Alarms (including network) | High | Medium | Open | Define alarms for NAT errors, API GW 5xx, VPC flow log rejects |
| 4 | Node-H3 | WebSocket token echoed in response header | High | Medium | Open | Use short-lived connection token; stop echoing JWT |
| 5 | WA-C1 / RDS-H1 | RDS Single-AZ (network availability) | High | Low | Open | Set `multiAz: isProd ? true : false` (~$50-70/month) |
| 6 | S-H4 / CDK-M2 | `dataTraceEnabled: true` logs privileged content | High | Low | Deferred | Set `dataTraceEnabled: false` before production |
| 7 | FE-H1 | Duplicate WebSocket connections | High | High | Deferred | Implement shared `WebSocketProvider` |
| 8 | RDS-M1 | RDS Proxy IAM wildcard resource | Medium | Low | Open | Scope `rds-db:connect` to specific DB instance ARN |
| 9 | RDS-M3 | No CloudWatch Alarms for DB health | Medium | Low | Open | Add alarms for connections, CPU, free storage |
| 10 | WA-L4 | VPC endpoints cost justification | Low | Low | Open | Evaluate cost vs security benefit for low-traffic periods |

---

### Findings

| ID | Title | Severity | Effort | Status |
|----|-------|----------|--------|--------|
| NW-H5 | Open networking findings from prior reviews remain unresolved — NAT SPOF, VPC-wide SG, no network monitoring | High | Low–Medium | Open |
| NW-M7 | Five Fixed networking findings warrant re-verification due to environment-specific config or cross-reference discrepancies | Medium | Low | New |
| NW-M8 | Seven networking security areas have no coverage in any existing review (DNS, NACLs, Lambda egress, Flow Logs, mTLS, inter-hop TLS, WAF logging) | Medium | Medium | New |

---

#### NW-H5: Open networking findings from prior reviews remain unresolved

- **Severity:** High
- **Section:** Cross-Cutting Findings Consolidation
- **Current State:** Six High-severity networking findings from prior reviews remain Open or Deferred per REMEDIATION-STATUS.md (audit-corrected 2025-07-21): NAT SPOF (CDK-H4/WA-H2), VPC-wide SG rule (RDS-H2), no CloudWatch Alarms (WA-H1), WebSocket token exposure (Node-H3), RDS Single-AZ (WA-C1/RDS-H1), and `dataTraceEnabled` (S-H4/CDK-M2 — Deferred).
- **Gap:** These findings collectively represent fundamental networking security gaps: no HA at the network layer, overly permissive network access to the database, no network monitoring/alerting, and API data exposure through logs. The absence of HA controls (NAT + RDS) means a single AZ failure results in total system outage.
- **Risk:** Combined risk profile: (1) AZ failure = complete unavailability for all users, (2) any compromised VPC resource can reach database on port 5432, (3) network attacks go undetected without alarms, (4) privileged legal content exposed in API Gateway logs accessible to anyone with CloudWatch access.
- **Recommendation:** Remediate in priority order: (1) NAT HA + RDS Multi-AZ (Low effort, immediate resilience), (2) Security group tightening (Low effort, immediate least-privilege), (3) CloudWatch Alarms for network metrics (Medium effort, operational visibility), (4) Disable `dataTraceEnabled` for production, (5) WebSocket token handling.
- **Effort:** Low–Medium (varies by finding; most are Low individual effort)
- **Cross-References:** CDK-H4, WA-H2, RDS-H2, WA-H1, Node-H3, WA-C1, RDS-H1, S-H4, CDK-M2
- **Status:** Open

---

#### NW-M7: Fixed networking findings warrant re-verification

- **Severity:** Medium
- **Section:** Cross-Cutting Findings Consolidation
- **Current State:** Five previously-Fixed networking findings have re-verification concerns: (1) TLS bypass (env-specific), (2) S3 CORS localhost (env-specific), (3) WebSocket throttling (cross-ref discrepancy), (4) Python stale connections (partial fix status conflict), (5) CORS wildcard fallback (env var dependency).
- **Gap:** Fixes that depend on environment-specific configuration (CDK context params, Lambda env vars) may not be consistently applied across all deployment environments. The REMEDIATION-STATUS.md audit (2025-07-21) corrected many false "Fixed" claims, suggesting prior verification was insufficient.
- **Risk:** If fixes are not consistently applied across environments: (1) TLS bypass could still exist in a non-audited environment, (2) production CORS could silently degrade, (3) Python database connections may fail intermittently. Risk is Medium because the primary deployment was verified in the audit.
- **Recommendation:** Conduct a targeted re-verification pass for these 5 findings across ALL deployed environments (dev, staging, production). Automate verification with CDK assertion tests that validate these properties on every deployment.
- **Effort:** Low
- **Cross-References:** S-C1, CDK-C1, S-H5, CDK-M4, S-H3, CDK-M6, Lambda-H3, S-M4
- **Status:** New

---

#### NW-M8: Networking coverage gaps not addressed by any existing review

- **Severity:** Medium
- **Section:** Cross-Cutting Findings Consolidation
- **Current State:** Seven networking security areas have no assessment in any of the 10 existing code reviews: (1) DNS/domain configuration and failover, (2) Network ACL rules as defense-in-depth, (3) Lambda function egress restrictions, (4) VPC Flow Log configuration and retention, (5) API Gateway mTLS evaluation, (6) CloudFront-to-origin TLS configuration, (7) WAF logging configuration and retention.
- **Gap:** Without assessment of these areas, the security posture has blind spots. Of particular concern: VPC Flow Logs and WAF logging are foundational for forensic investigation (addressed in §7 of this review), and Lambda egress restrictions are a defense-in-depth gap (all Lambda functions can reach any internet host via NAT).
- **Risk:** (1) No forensic capability if a network-level incident occurs (flow logs status unknown), (2) Lambda compromise could exfiltrate data to any destination without egress restrictions, (3) DNS misconfiguration could cause availability issues without failover, (4) WAF events may not be retained long enough for incident investigation.
- **Recommendation:** These gaps are addressed by subsequent sections of this review document: §7 (Transport Security — addresses inter-hop TLS), §8 (Network Monitoring — addresses Flow Logs and WAF logging), §11 (Production Readiness — addresses NACLs, Lambda egress, DNS). Priority: Flow Logs and WAF logging > Lambda egress > NACLs > DNS/mTLS.
- **Effort:** Medium (assessment and remediation require infrastructure changes)
- **Cross-References:** —
- **Status:** New

---

## 10. WAF Rule Effectiveness Analysis

> *Requirement 9: Document WAF Rule Effectiveness and Gap Analysis*

This section evaluates WAF rule effectiveness against the OWASP Top 10 (2021), assesses coverage for API-specific attacks, analyzes false-positive risk for the legal AI use case, and recommends rule additions tailored to the platform's threat model.

### 10.1 OWASP Top 10 (2021) Mapping

The following table maps each OWASP Top 10 (2021) category to WAF rules currently active across both ACLs (CloudFront-scoped `waf-stack.ts` and Regional API Gateway-scoped `api-stack.ts`). Both ACLs deploy `AWSManagedRulesCommonRuleSet` with `overrideAction: { none: {} }` (all rules in default block mode).

| OWASP Category | WAF Rules (CloudFront) | WAF Rules (API GW) | Coverage Assessment |
|----------------|------------------------|--------------------|--------------------|
| **A01: Broken Access Control** | Rate limit (LimitRequests1000) | Rate limit (LimitRequests2000), PerUserRateLimit (200/5min) | ⚠️ **Partial** — Rate limiting mitigates brute-force enumeration but WAF cannot enforce object-level authorization. No rule detects IDOR probing patterns (sequential ID iteration). Primary defense relies on Lambda authorizers + application logic. |
| **A02: Cryptographic Failures** | None | None | ❌ **Not WAF-addressable** — Cryptographic failures (weak TLS, missing encryption) are infrastructure concerns. WAF operates at Layer 7 and cannot inspect TLS configuration. Addressed in §6 Transport Security. |
| **A03: Injection** | `AWSManagedRulesCommonRuleSet` (CrossSiteScripting_BODY, CrossSiteScripting_QUERYARGUMENTS, CrossSiteScripting_COOKIE, CrossSiteScripting_URIPATH) | Same rules | ⚠️ **Partial** — XSS rules active. **No SQLi-specific rule group** (AWSManagedRulesSQLiRuleSet absent). CommonRuleSet provides basic injection detection but not comprehensive SQL injection patterns for PostgreSQL. No OS command injection rules (AWSManagedRulesLinuxRuleSet absent). |
| **A04: Insecure Design** | None | None | ❌ **Not WAF-addressable** — Insecure design is an architectural concern. WAF cannot detect design flaws. Addressed through Bedrock Guardrails (prompt injection prevention) and application-level controls. |
| **A05: Security Misconfiguration** | `AWSManagedRulesCommonRuleSet` (NoUserAgent_HEADER, SizeRestrictions_*) | Same rules | ⚠️ **Partial** — Detects missing User-Agent and oversized payloads. However, no rules for error message information disclosure, default credential probing, or unnecessary HTTP method blocking (PUT/DELETE on static resources). |
| **A06: Vulnerable Components** | None | None | ❌ **Gap** — No `AWSManagedRulesKnownBadInputsRuleSet` deployed. This rule group detects exploitation patterns for known CVEs (Log4Shell/Log4j2, Spring4Shell, Java deserialization). Platform uses Python (LangChain, boto3) and Node.js — Java-specific rules have limited applicability, but Log4j patterns appear in request headers regardless of backend language. |
| **A07: Identification & Authentication Failures** | Rate limit (LimitRequests1000) | Rate limit (LimitRequests2000), PerUserRateLimit | ⚠️ **Partial** — Rate limiting mitigates credential stuffing velocity. No rule specifically targets authentication endpoints (Cognito-hosted UI is separate). Primary defense: Cognito lockout policies + password complexity requirements. |
| **A08: Software and Data Integrity Failures** | None | None | ❌ **Not WAF-addressable** — Supply chain and deserialization attacks cannot be detected at the WAF layer. No `AWSManagedRulesKnownBadInputsRuleSet` for Java deserialization patterns (limited applicability given Python/Node.js backend). |
| **A09: Security Logging and Monitoring Failures** | CloudWatch metrics only (no WAF logging) | CloudWatch metrics only (no WAF logging) | ❌ **Critical Gap** — Neither WAF has `CfnLoggingConfiguration`. Without request-level logging, WAF-blocked attacks cannot be investigated, attack patterns cannot be correlated, and no audit trail exists. See findings NW-H1 in §4 and §5. |
| **A10: Server-Side Request Forgery (SSRF)** | None | None | ❌ **Gap** — No SSRF-specific rules. Lambda functions make outbound calls to AWS services (Bedrock, S3, Secrets Manager). If user input reaches URL construction (unlikely given current architecture), SSRF is possible. Primary mitigation: Lambda functions do not accept user-supplied URLs for outbound requests. Risk is **Low** given current application design. |

**Summary:** 3 of 10 OWASP categories have partial WAF coverage, 3 are not WAF-addressable (require infrastructure/design controls), and 4 have gaps that WAF rule additions could address (A03 Injection, A06 Vulnerable Components, A09 Logging, A10 SSRF).

### 10.2 AWSManagedRulesCommonRuleSet Action Modes

Both WAF ACLs apply `AWSManagedRulesCommonRuleSet` with `overrideAction: { none: {} }`, meaning all rules within the group execute in their **default action** (block). No individual rule overrides (`excludedRules`) are configured.

**Code Evidence (`waf-stack.ts` lines 36–52, `api-stack.ts` WAF section):**
```typescript
{
  name: "AWS-AWSManagedRulesCommonRuleSet",
  priority: 1,
  statement: {
    managedRuleGroupStatement: {
      vendorName: "AWS",
      name: "AWSManagedRulesCommonRuleSet",
    },
  },
  overrideAction: { none: {} },  // All rules active in default (block) mode
}
```

The following table lists all rules within AWSManagedRulesCommonRuleSet (current version as of 2024) with their default action and threat model assessment for LAIGO:

| Rule Name | Default Action | Threat Model Assessment for Legal AI Platform |
|-----------|---------------|----------------------------------------------|
| `NoUserAgent_HEADER` | Block | ✅ Appropriate — blocks basic scanning tools |
| `UserAgent_BadBots_HEADER` | Block | ✅ Appropriate — blocks known malicious bot User-Agent strings |
| `SizeRestrictions_QUERYSTRING` | Block (>2048 bytes) | ✅ Appropriate — legal queries do not exceed this |
| `SizeRestrictions_Cookie_HEADER` | Block (>10240 bytes) | ✅ Appropriate — Cognito JWTs fit within limit |
| `SizeRestrictions_BODY` | Block (>8192 bytes / 8 KB) | ❌ **CRITICAL FALSE POSITIVE** — Legal documents for AI analysis routinely exceed 8 KB. A 5,000-word legal document is ~30 KB. This blocks core platform functionality. See §5 NW-H2. |
| `SizeRestrictions_URIPATH` | Block (>1024 bytes) | ✅ Appropriate — API paths are well under this limit |
| `EC2MetaDataSSRF_BODY` | Block | ✅ Appropriate — detects SSRF attempts targeting EC2 metadata endpoint |
| `EC2MetaDataSSRF_COOKIE` | Block | ✅ Appropriate |
| `EC2MetaDataSSRF_URIPATH` | Block | ✅ Appropriate |
| `EC2MetaDataSSRF_QUERYARGUMENTS` | Block | ✅ Appropriate |
| `GenericLFI_QUERYARGUMENTS` | Block | ✅ Appropriate — blocks local file inclusion patterns |
| `GenericLFI_URIPATH` | Block | ✅ Appropriate |
| `GenericLFI_BODY` | Block | ⚠️ **Potential false positive** — Legal text containing file path-like patterns (e.g., "section 5(a)/paragraph (b)") could theoretically match LFI signatures. Risk is low but warrants count-only monitoring. |
| `RestrictedExtensions_URIPATH` | Block | ✅ Appropriate — blocks `.php`, `.asp`, etc. extensions not used by the API |
| `RestrictedExtensions_QUERYARGUMENTS` | Block | ✅ Appropriate |
| `GenericRFI_QUERYARGUMENTS` | Block | ✅ Appropriate — blocks remote file inclusion |
| `GenericRFI_BODY` | Block | ⚠️ **Potential false positive** — Legal documents containing URLs (case citation hyperlinks, statute references) may trigger RFI detection if URLs point to non-allowlisted domains. |
| `GenericRFI_URIPATH` | Block | ✅ Appropriate |
| `CrossSiteScripting_COOKIE` | Block | ✅ Appropriate |
| `CrossSiteScripting_QUERYARGUMENTS` | Block | ✅ Appropriate |
| `CrossSiteScripting_BODY` | Block | ⚠️ **Moderate false positive risk** — Legal text containing HTML-like markup (e.g., `<i>R v. Smith</i>`, `<em>supra</em>`) or angle brackets in legal analysis could trigger XSS rules. |
| `CrossSiteScripting_URIPATH` | Block | ✅ Appropriate |

**Critical Finding:** `SizeRestrictions_BODY` (8 KB limit) actively blocks legitimate platform functionality. The `overrideAction: { none: {} }` with no `excludedRules` means this rule cannot be selectively disabled without modifying the CDK configuration. This is the highest-priority WAF effectiveness gap.

**Count-Only Assessment:** Currently, **zero rules operate in count-only mode** — all are in block mode. Given the legal content domain, the following rules should be considered for count-only mode during initial deployment or with exclusion path patterns for AI endpoints:
- `GenericRFI_BODY` — monitor for false positives on legal documents with URLs
- `CrossSiteScripting_BODY` — monitor for false positives on legal formatting
- `GenericLFI_BODY` — monitor for false positives on legal citation paths

### 10.3 API-Specific Attack Coverage

This subsection evaluates WAF coverage for three API-specific attack patterns relevant to LAIGO's REST API architecture:

#### Broken Object-Level Authorization (BOLA) Probing

**Current Coverage: ❌ No WAF-level protection**

- **Attack Pattern:** An authenticated user iterates through predictable resource IDs (e.g., `/student/cases/1`, `/student/cases/2`, `/student/cases/3`) to access resources belonging to other users.
- **Current State:** The PerUserRateLimit (200 req/5min) provides velocity-based detection — an attacker iterating through IDs would consume their rate limit quickly. However, 200 requests in 5 minutes allows probing ~200 unique case IDs before blocking.
- **Why WAF cannot fully address this:** BOLA is an application-logic vulnerability. The WAF has no visibility into resource ownership. Authorization must be enforced at the Lambda handler level (which the platform does via Lambda authorizers + database ownership queries).
- **WAF contribution possible:** A custom rule could detect sequential numeric parameter patterns in URL paths (regex match on repeated requests to `/student/cases/\d+` with incrementing IDs), but this is fragile and produces false positives on legitimate navigation.
- **Assessment:** The primary defense (Lambda authorizer + application-level ownership checks) is appropriate. WAF rate limiting provides secondary velocity control. **No WAF rule addition recommended** — this is correctly an application-layer defense.

#### Excessive Response Payloads (>8 KB)

**Current Coverage: ❌ No WAF-level protection (WAF inspects requests, not responses)**

- **Attack Pattern:** An attacker crafts requests that cause the API to return excessive data (e.g., requesting full case transcripts, bulk user data, or AI-generated responses without pagination).
- **Current State:** AWS WAF operates on **inbound requests only** — it cannot inspect or limit response payloads. The 8 KB `SizeRestrictions_BODY` rule applies to request bodies, not responses.
- **Why WAF cannot address this:** WAF v2 does not support response inspection. Response size limiting must be implemented at the application layer.
- **Application-level controls:**
  - AI Lambda functions have model-level `maxTokens` parameter (configurable via SSM, default 2048 tokens ≈ 8 KB of text output)
  - API Gateway does not impose response size limits (supports up to 10 MB synchronous responses)
  - No pagination enforcement detected on database query endpoints
- **Assessment:** Response payload limiting requires application-level controls (pagination, max token limits). **No WAF rule addition possible.** Recommend implementing API Gateway response size validation via Lambda response transformation or API Gateway models with `maxLength` constraints on response bodies.

#### Mass Assignment Attacks

**Current Coverage: ❌ No WAF-level protection**

- **Attack Pattern:** An attacker sends additional fields in request bodies (e.g., `{"role": "admin", "caseText": "..."}`) hoping the backend assigns them without validation.
- **Current State:** No WAF rule validates request body schemas. The WAF allows any JSON structure through (within the 8 KB body limit).
- **Why WAF has limited effectiveness here:** Mass assignment prevention requires schema validation — validating that only expected fields are present. AWS WAF's regex/string-matching capabilities are insufficient for full JSON schema validation.
- **Application-level controls:**
  - Node.js Lambda handlers use route-map dispatch (e.g., `adminFunction.js`, `studentFunction.js`) with explicit field extraction from request bodies
  - Python AI Lambda handlers accept specific parameters from the request event
  - No evidence of blanket `Object.assign()` or `**kwargs` patterns that would enable mass assignment
  - Database layer uses parameterized queries with explicit column mappings
- **Assessment:** The application architecture naturally resists mass assignment through explicit field extraction. **No WAF rule addition recommended.** However, recommend adding API Gateway request validation models (JSON Schema) as defense-in-depth — this provides schema enforcement before requests reach Lambda, which the WAF cannot provide.

### 10.4 False-Positive Risk for Legal Content

Legal AI platforms process text with unique characteristics that differ from typical web applications. Legal content frequently contains SQL-like keywords, path-like references, and formatting that triggers security rules designed for general web traffic.

#### Representative Legal Content Analysis

**Test Scenario:** A 5,000+ character legal input containing:
- Case citations: *R v. Smith [2023] SCC 15*, *Brown v. Board of Education, 347 U.S. 483 (1954)*
- Statutory references: *Criminal Code, RSC 1985, c C-46, s 718.2(a)(i)*
- SQL-like keywords in legal context: "The court must **select** the appropriate sentencing range", "The **order** of the court was that...", "The **union** of the two legal principles...", "**drop** the charges", "**insert** the clause into section 3", "**delete** paragraph (b) from the agreement", "**where** the evidence demonstrates...", "**grant** the motion"
- Legal HTML-like formatting: `<i>supra</i>`, `<em>ibid</em>`, case names with angle brackets in some citation styles
- File path-like patterns: `s 5(a)/para (b)/subpara (iii)`, `Part II/Division 3/Section 42`

#### Rule-by-Rule False Positive Assessment

| CommonRuleSet Rule | False-Positive Trigger Pattern | Risk Level | Impact |
|-------------------|-------------------------------|------------|--------|
| `SizeRestrictions_BODY` (8 KB) | Any legal document >8 KB (virtually all AI analysis inputs) | **CRITICAL** | Blocks core functionality — summarization, chat with case context, playground testing |
| `CrossSiteScripting_BODY` | Legal text with `<i>case name</i>` formatting, angle brackets in citations | **Medium** | May block submissions containing italicized case names or HTML formatting pasted from legal databases |
| `GenericRFI_BODY` | Legal text containing URLs to case law databases (CanLII, Westlaw, SSRN) | **Low-Medium** | May trigger on documents with multiple external URLs |
| `GenericLFI_BODY` | Statutory references with path separators: `RSC 1985/c C-46/s 718` | **Low** | Path separator usage in legal citations is uncommon in request bodies |
| `CrossSiteScripting_QUERYARGUMENTS` | Search queries containing case names with special characters | **Low** | API uses POST for content submission; query strings are short |

#### SQL-Like Keywords Assessment

The `AWSManagedRulesCommonRuleSet` does **not** include SQL injection detection rules — that requires `AWSManagedRulesSQLiRuleSet`. Therefore, SQL-like keywords ("select", "order", "union", "drop", "insert", "where", "grant") in legal text **do not trigger the currently deployed rules**.

However, if `AWSManagedRulesSQLiRuleSet` is added (recommended for defense-in-depth per §5 NW-M4):

| SQL Keyword in Legal Context | Example Legal Usage | SQLi Rule Trigger Risk |
|-------|---------------------|----------------------|
| "SELECT" | "The court must select the appropriate remedy" | Low — requires SQL syntax structure (SELECT...FROM) |
| "ORDER" | "The order of the court", "order for costs" | Low — standalone word without SQL context |
| "UNION" | "The union of these principles", "trade union" | **Medium** — "UNION SELECT" patterns in mixed legal/technical text could trigger |
| "DROP" | "Motion to drop the charges" | Low — requires "DROP TABLE" or "DROP DATABASE" pattern |
| "WHERE" | "Where the evidence shows..." | Low — requires SQL clause structure |
| "INSERT" | "Insert clause 3 into the agreement" | Low — requires "INSERT INTO" pattern |

**Mitigation Strategy:** If `AWSManagedRulesSQLiRuleSet` is deployed, use **scope-down statements** to exclude AI content endpoints (`/student/*/chat`, `/student/*/summary`, `/admin/playground`) from SQLi inspection, or deploy initially in **count-only mode** to measure false-positive rates over 30 days before switching to block.

#### Overall False-Positive Assessment

| Risk Category | Severity | Affected Functionality | Recommended Action |
|--------------|----------|----------------------|-------------------|
| Body size limit (8 KB) | **Critical** | All AI analysis, summarization, chat | Exclude `SizeRestrictions_BODY` + add custom size rule (see §5 NW-H2) |
| XSS on legal formatting | **Medium** | Document submissions with HTML-like citations | Monitor in CloudWatch; add URI-based exclusion for AI endpoints if false positives detected |
| RFI on embedded URLs | **Low** | Documents with links to legal databases | Monitor only; unlikely to trigger at current usage patterns |
| SQLi (if added) | **Medium** | Legal text with SQL-coincident vocabulary | Deploy SQLi rule group in count-only mode; scope-down AI endpoints |

### 10.5 Legal AI Use Case WAF Recommendations

This subsection provides WAF rule recommendations specifically tailored to protecting the LAIGO legal AI platform's AI endpoints against abuse while preserving legitimate functionality.

#### AI Endpoint Inventory

| Endpoint | Lambda Function | Typical Request Size | Typical Latency | Rate Sensitivity |
|----------|----------------|---------------------|-----------------|-----------------|
| Text Generation (Chat) | `TextGenLambdaDockerFunction` | 1–50 KB (conversation context) | 10–120s (streaming) | High — expensive Bedrock calls |
| Summary Generation | `SummaryGenerationFunction` | 5–100 KB (full case text) | 30–120s | High — expensive, involves full case |
| Playground Generation | `PlaygroundTextGenLambdaDockerFunction` | 1–30 KB (test prompts) | 10–120s | Medium — admin-only endpoint |
| Case Generation | `CaseLambdaDockerFunction` | 1–5 KB (parameters) | 10–30s | Medium — triggered less frequently |
| Audio Transcription | `audioToTextFunction` | Metadata only (audio via S3) | 30–120s | Low — limited by recording availability |
| Progress Assessment | `assessProgressFunction` | 2–10 KB | 10–30s | Low — supervisor-triggered |

#### Current Protection Assessment

**Current State:** All AI endpoints are protected by the same uniform rate limits:
- IP-based: 2,000 req/5 min (API Gateway WAF)
- Per-user: 200 req/5 min (PerUserRateLimit, MD5 of Authorization header)

**Gap Analysis:**

The per-user rate limit of 200 req/5min is appropriate for REST API browsing but **excessively permissive for AI endpoints** given their cost profile:

| Endpoint | Legitimate Peak Usage (per user/5min) | Current Limit | Abuse Window |
|----------|---------------------------------------|---------------|--------------|
| Text Generation | 10–20 messages (rapid conversation) | 200 | Attacker can trigger 200 Bedrock invocations in 5 min (~$0.50–$2.00 per burst at Sonnet 4 pricing) |
| Summary Generation | 2–5 summaries (reviewing multiple cases) | 200 | Attacker can trigger 200 summary operations (~$4.00–$10.00 per burst) |
| Playground | 5–15 iterations (admin testing prompts) | 200 | Attacker can trigger 200 playground invocations |
| Pre-signed URL | 3–5 recordings per session | 200 | See §10.6 below |

**The uniform 200 req/5min limit allows ~200 AI endpoint calls per user per 5-minute window. At Bedrock pricing (~$0.003–$0.015 per 1K tokens output), an automated script exploiting a single compromised account could generate $2–$15 in Bedrock costs per 5-minute window ($576–$4,320/day).**

#### Recommended WAF Rule Additions

**Recommendation 1: AI Endpoint-Specific Rate Limit Rule**

Add a custom rate-based rule targeting AI endpoint URI patterns with a stricter threshold:

```typescript
{
  name: "AIEndpointRateLimit",
  priority: 4,  // After PerUserRateLimit
  action: { block: {} },
  statement: {
    rateBasedStatement: {
      limit: 30, // 30 requests per 5 minutes per user to AI endpoints
      aggregateKeyType: "CUSTOM_KEYS",
      customKeys: [
        {
          header: {
            name: "Authorization",
            textTransformations: [{ priority: 0, type: "MD5" }],
          },
        },
      ],
      scopeDownStatement: {
        orStatement: {
          statements: [
            {
              byteMatchStatement: {
                fieldToMatch: { uriPath: {} },
                positionalConstraint: "CONTAINS",
                searchString: "/chat",
                textTransformations: [{ priority: 0, type: "LOWERCASE" }],
              },
            },
            {
              byteMatchStatement: {
                fieldToMatch: { uriPath: {} },
                positionalConstraint: "CONTAINS",
                searchString: "/summary",
                textTransformations: [{ priority: 0, type: "LOWERCASE" }],
              },
            },
            {
              byteMatchStatement: {
                fieldToMatch: { uriPath: {} },
                positionalConstraint: "CONTAINS",
                searchString: "/playground",
                textTransformations: [{ priority: 0, type: "LOWERCASE" }],
              },
            },
            {
              byteMatchStatement: {
                fieldToMatch: { uriPath: {} },
                positionalConstraint: "CONTAINS",
                searchString: "/case-generation",
                textTransformations: [{ priority: 0, type: "LOWERCASE" }],
              },
            },
          ],
        },
      },
    },
  },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "AIEndpointRateLimit",
  },
}
```

**Justification:** 30 req/5min per user allows legitimate peak usage (an advocate sending ~6 messages/min in an active AI conversation) while preventing automated abuse. Legitimate users in rapid conversation will not exceed 30 AI requests in 5 minutes.

**Recommendation 2: Bot Control for AI Endpoints (Deferred)**

Add `AWSManagedRulesBotControlRuleSet` with scope-down to AI endpoints only after WAF logging provides baseline traffic data. Bot control detects automated access patterns (headless browsers, scripted requests) that evade simple rate limiting.

- **Timing:** Deploy after WAF logging is enabled (§4 NW-H1, §5 NW-H1) and 30 days of baseline data is collected
- **Cost:** ~$10/month + $1/million requests inspected
- **Scope:** Apply only to AI endpoints to minimize cost

**Recommendation 3: Custom Rule for Repeated Identical Payloads**

While not directly implementable in WAF (which lacks cross-request payload comparison), the WebSocket `default` Lambda function (`wsDefaultFunction`) should implement application-level duplicate detection:

- Track message hashes per user session
- Reject identical messages submitted within 5 seconds
- This prevents copy-paste automation attacks that stay under rate limits but generate identical Bedrock calls

### 10.6 Pre-Signed URL Endpoint Protection

#### Current Configuration

**Endpoint:** `GeneratePreSignedURLFunction` — generates S3 pre-signed URLs for audio file uploads.

**Code Evidence (`api-stack.ts` lines 1985–2022):**
```typescript
const generatePreSignedURL = new lambda.Function(this, `${id}-GeneratePreSignedURLFunction`, {
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset("lambda/generatePreSignedURL"),
  handler: "generatePreSignedURL.lambda_handler",
  timeout: Duration.seconds(29),
  memorySize: 128,
  environment: {
    BUCKET: audioStorageBucket.bucketName,
    REGION: this.region,
    ...corsEnv,
  },
});
```

**Protection layers currently in place:**
1. Lambda authorizer (student/instructor/admin authorization required)
2. API Gateway stage throttle: 100 req/s, 200 burst
3. WAF IP-based rate limit: 2,000 req/5 min
4. WAF per-user rate limit: 200 req/5 min (MD5 of Authorization header)

#### Data Exfiltration Risk Assessment

**Attack Scenario:** A compromised authenticated account generates bulk pre-signed URLs to exfiltrate S3 objects or create a large number of upload slots for malicious content staging.

**Current limits allow:**
- Per user: **200 pre-signed URLs per 5-minute window** (PerUserRateLimit)
- Per IP: **2,000 pre-signed URLs per 5-minute window** (if multiple accounts from same IP)

**Risk Assessment:**

| Metric | Current Limit | Legitimate Peak | Abuse Potential |
|--------|---------------|-----------------|-----------------|
| URLs per user/5min | 200 | 3–5 (one per audio recording) | 200 URLs = 200 upload slots or download capabilities |
| URLs per user/hour | 2,400 (12 windows) | 10–20 (an active interview session) | 2,400 potential upload/download slots per hour |
| S3 bucket lifecycle | 7-day auto-delete | N/A | Uploaded malicious content persists for up to 7 days |

**The current per-user limit of 200 req/5min is ~40x higher than legitimate usage for pre-signed URLs.**

A compromised account could:
1. Generate 200 upload pre-signed URLs per 5-minute window
2. Upload 200 files (up to bucket size limits) per 5-minute window
3. Use the platform's S3 bucket as a staging ground for malicious content distribution
4. Potentially upload and share audio files that consume significant storage

#### Recommendation: Endpoint-Specific Rate Limit for Pre-Signed URLs

```typescript
{
  name: "PreSignedURLRateLimit",
  priority: 5,
  action: { block: {} },
  statement: {
    rateBasedStatement: {
      limit: 50, // 50 requests per 5 minutes per user — well above legitimate use
      aggregateKeyType: "CUSTOM_KEYS",
      customKeys: [
        {
          header: {
            name: "Authorization",
            textTransformations: [{ priority: 0, type: "MD5" }],
          },
        },
      ],
      scopeDownStatement: {
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: "CONTAINS",
          searchString: "/presigned",
          textTransformations: [{ priority: 0, type: "LOWERCASE" }],
        },
      },
    },
  },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "PreSignedURLRateLimit",
  },
}
```

**Justification:**
- 50 req/5min is 10x legitimate peak usage (3–5 per session)
- Prevents bulk URL generation while allowing bursts during active recording sessions
- Combined with the 7-day lifecycle rule on the S3 bucket, limits the duration of any staged content
- Note: This requires the pre-signed URL endpoint path to contain "presigned" — verify against `OpenAPI_Swagger_Definition.yaml`

**Additional Application-Level Controls Recommended:**
1. **Lambda-level validation:** The `generatePreSignedURL.py` handler should enforce per-user daily limits (e.g., 100 URLs/day) via DynamoDB counter, providing defense-in-depth beyond WAF
2. **S3 bucket policy:** Add a condition limiting objects per prefix (user-specific prefixes) to cap storage per user
3. **URL expiration:** Ensure pre-signed URLs have short expiration times (5–15 minutes) to limit the window for misuse

### Findings

| ID | Title | Severity | Effort | Status |
|----|-------|----------|--------|--------|
| NW-H1 | OWASP coverage gaps: no KnownBadInputsRuleSet, SQLiRuleSet, or dedicated injection protection beyond CommonRuleSet | High | Low | New |
| NW-H2 | SizeRestrictions_BODY (8 KB) blocks legitimate legal content — core platform functionality broken | High | Low | New |
| NW-H3 | No WAF logging on either ACL prevents OWASP A09 compliance and incident investigation | High | Low | New |
| NW-M1 | AI endpoints unprotected against high-frequency automated abuse (200 req/5min uniform limit vs. 30 req/5min needed) | Medium | Low | New |
| NW-M2 | Pre-signed URL endpoint allows bulk generation (200/5min vs. 50/5min threshold) — data staging risk | Medium | Low | New |
| NW-M3 | False-positive risk for legal content: XSS and RFI rules may block legitimate case citations with HTML-like formatting | Medium | Medium | New |
| NW-L1 | No geo-restriction at WAF layer for OWASP A01 geographic access control (covered separately in §4 NW-H2) | Low | Low | New |

---

### Finding Details

---

#### NW-H1: OWASP Coverage Gaps — Missing Managed Rule Groups

- **Severity:** High
- **Section:** 10. WAF Rule Effectiveness Analysis
- **Current State:** Both WAF ACLs deploy only `AWSManagedRulesCommonRuleSet` (priority 1) plus rate-limiting rules. No additional managed rule groups are configured.
  ```typescript
  // waf-stack.ts and api-stack.ts — identical pattern
  managedRuleGroupStatement: {
    vendorName: "AWS",
    name: "AWSManagedRulesCommonRuleSet",
  },
  overrideAction: { none: {} },
  ```
- **Gap:** Three OWASP categories lack dedicated WAF protection:
  - **A03 Injection:** No `AWSManagedRulesSQLiRuleSet` — relies solely on CommonRuleSet XSS rules. The platform has a PostgreSQL backend (RDS) making SQLi a relevant threat.
  - **A06 Vulnerable Components:** No `AWSManagedRulesKnownBadInputsRuleSet` — known CVE exploitation patterns (Log4Shell, Spring4Shell) are undetected at the perimeter.
  - **A10 SSRF:** No dedicated SSRF protection beyond CommonRuleSet's `EC2MetaDataSSRF_*` rules.
- **Risk:** An attacker could exploit SQL injection patterns that bypass application-level parameterized queries (e.g., second-order injection via stored procedures, or injection in less-tested endpoints). Known exploitation patterns for widespread CVEs reach Lambda functions unfiltered, requiring application-layer-only defense.
- **Recommendation:** Add managed rule groups to the API Gateway WAF (higher priority) and CloudFront WAF:
  1. `AWSManagedRulesKnownBadInputsRuleSet` — **block mode** (low false-positive risk, high value)
  2. `AWSManagedRulesSQLiRuleSet` — **count-only mode initially** with scope-down excluding AI content endpoints, transition to block after 30-day monitoring
  3. `AWSManagedRulesAmazonIpReputationList` — **block mode** (zero false-positive risk for legitimate users)
- **Effort:** Low — CDK configuration addition, no code changes
- **Cross-References:** §5 NW-M1 (KnownBadInputs), §5 NW-M4 (SQLi), §4 NW-M2 (KnownBadInputs on CloudFront)
- **Status:** New

---

#### NW-H2: SizeRestrictions_BODY Blocks Core Legal Platform Functionality

- **Severity:** High
- **Section:** 10. WAF Rule Effectiveness Analysis
- **Current State:** `AWSManagedRulesCommonRuleSet` applied with `overrideAction: { none: {} }` and no `excludedRules`. The `SizeRestrictions_BODY` rule enforces an 8 KB request body limit in block mode.
- **Gap:** Legal documents submitted for AI analysis routinely exceed 8 KB:
  - Average legal case summary input: 15–50 KB
  - Chat conversation context (multi-turn): 5–30 KB
  - Playground prompt testing: 2–20 KB
  - These legitimate requests are **silently blocked** at the WAF layer before reaching the application.
- **Risk:** Core platform functionality (AI chat, summarization, playground) is non-functional for any input exceeding 8 KB. Users receive generic 403 errors with no indication that WAF is the cause. This is a **functional regression introduced by security controls**.
- **Recommendation:**
  1. Add `SizeRestrictions_BODY` to `excludedRules` in both WAF ACLs
  2. Add a custom size constraint rule with appropriate tiered limits:
     - AI endpoints (`/student/*/chat`, `/student/*/summary`, `/admin/playground`): 1 MB max body
     - All other endpoints: 256 KB max body
  3. The custom rule provides meaningful size protection while accommodating legal content
- **Effort:** Low — CDK configuration change
- **Cross-References:** §5 NW-H2 (same finding, assessed from API Gateway perspective)
- **Status:** New

---

#### NW-H3: No WAF Logging Prevents OWASP A09 Compliance

- **Severity:** High
- **Section:** 10. WAF Rule Effectiveness Analysis
- **Current State:** Neither WAF ACL has `CfnLoggingConfiguration`. Only CloudWatch metrics and 3-hour sampled request data are available.
- **Gap:** OWASP A09 (Security Logging and Monitoring Failures) is directly violated. Without persistent WAF logs:
  - Attack patterns cannot be analyzed retroactively
  - False-positive rates cannot be measured (critical for legal content assessment in §10.4)
  - Rate-limit effectiveness cannot be validated
  - The recommendations in this section (§10.5 AI endpoint limits, §10.6 pre-signed URL limits) cannot be tuned without traffic data
- **Risk:** The entire WAF effectiveness analysis in this section relies on theoretical assessment rather than empirical data. Without logging, false-positive recommendations are based on pattern analysis rather than observed blocked requests. A 30-day monitoring period with logging enabled is prerequisite to implementing the recommendations safely.
- **Recommendation:** Enable WAF logging as **first priority** before implementing any rule additions from this section. Deploy in this order:
  1. Enable `CfnLoggingConfiguration` on both WAFs (see §4 NW-H1, §5 NW-H1)
  2. Collect 30 days of baseline data
  3. Analyze false-positive rates for legal content
  4. Implement rule additions with confidence
- **Effort:** Low — CDK configuration
- **Cross-References:** §4 NW-H1 (CloudFront WAF logging), §5 NW-H1 (API Gateway WAF logging), §8 NW-M8 (monitoring gaps)
- **Status:** New

---

#### NW-M1: AI Endpoints Lack Targeted Rate Limiting Against Automated Abuse

- **Severity:** Medium
- **Section:** 10. WAF Rule Effectiveness Analysis
- **Current State:** All API endpoints share a uniform per-user rate limit of 200 req/5min:
  ```typescript
  {
    name: "PerUserRateLimit",
    priority: 3,
    action: { block: {} },
    statement: {
      rateBasedStatement: {
        limit: 200,
        aggregateKeyType: "CUSTOM_KEYS",
        customKeys: [{
          header: { name: "Authorization", textTransformations: [{ priority: 0, type: "MD5" }] },
        }],
      },
    },
  }
  ```
- **Gap:** AI endpoints (text generation, summary generation, playground, case generation) invoke Amazon Bedrock with per-token costs. The uniform 200 req/5min limit allows a single compromised account to trigger ~200 Bedrock invocations per 5-minute window, generating $2–$15 in compute costs per window ($576–$4,320/day potential abuse).
- **Risk:** Financial abuse via compromised credentials. An attacker with one valid JWT can automate AI endpoint calls at 200 req/5min, exhausting Bedrock quotas and generating significant costs. The platform's legitimate peak AI usage is 10–20 req/5min per user.
- **Recommendation:** Add a scoped rate-based rule (see §10.5 Recommendation 1) limiting AI endpoints to 30 req/5min per user. This provides a 1.5–3x safety margin above legitimate peak usage while reducing abuse potential by 85%.
- **Effort:** Low — CDK rule addition
- **Cross-References:** §5 PerUserRateLimit assessment
- **Status:** New

---

#### NW-M2: Pre-Signed URL Endpoint Allows Bulk URL Generation

- **Severity:** Medium
- **Section:** 10. WAF Rule Effectiveness Analysis
- **Current State:** The `GeneratePreSignedURLFunction` endpoint is protected only by the uniform per-user rate limit (200 req/5min). The function generates S3 pre-signed upload URLs for audio recording storage.
- **Gap:** Legitimate usage of pre-signed URLs is 3–5 per recording session. The current limit of 200 per 5-minute window allows an attacker to:
  - Generate 200 upload URLs in 5 minutes
  - Upload 200 arbitrary files to the S3 bucket
  - Use the platform's S3 infrastructure as a malicious content staging ground
  - The 7-day lifecycle rule provides some mitigation but content persists for up to 7 days
- **Risk:** A compromised account could abuse the pre-signed URL endpoint for:
  1. Storage abuse (filling bucket with large files)
  2. Content staging (hosting malicious files behind legitimate-looking S3 URLs for phishing)
  3. Cost abuse (S3 storage and request charges)
  The risk is Medium because authentication is required, limiting the attack to compromised accounts.
- **Recommendation:** Add an endpoint-specific rate limit of 50 req/5min per user for the pre-signed URL endpoint (see §10.6 implementation). Additionally, implement application-level daily limits (100 URLs/user/day) in the Lambda handler via DynamoDB counter.
- **Effort:** Low — CDK rule addition + minor Lambda code change
- **Cross-References:** None (new finding specific to this assessment)
- **Status:** New

---

#### NW-M3: False-Positive Risk for Legal Content with XSS/RFI Rules

- **Severity:** Medium
- **Section:** 10. WAF Rule Effectiveness Analysis
- **Current State:** `CrossSiteScripting_BODY` and `GenericRFI_BODY` rules within `AWSManagedRulesCommonRuleSet` are active in block mode. Legal content frequently contains HTML-like formatting (`<i>case name</i>`, `<em>supra</em>`) and URLs to legal databases (CanLII, Westlaw, court websites).
- **Gap:** Without WAF logging (§10 NW-H3), the false-positive rate for these rules on legal content **cannot be measured**. Theoretical analysis suggests Medium risk:
  - XSS rules use pattern matching that may flag italicized case name formatting
  - RFI rules may flag legal documents containing multiple external URLs
  - Current user base has not reported WAF-related blocking (may indicate the 8 KB size limit blocks requests before XSS/RFI rules are evaluated)
- **Risk:** Once `SizeRestrictions_BODY` is excluded (per NW-H2 recommendation), larger legal documents will reach the XSS and RFI rules for the first time. False positives may emerge that were previously masked by the size limit. Advocates submitting case documents with HTML formatting or URL references could be blocked without clear error messaging.
- **Recommendation:**
  1. Enable WAF logging first (NW-H3)
  2. After excluding `SizeRestrictions_BODY`, monitor XSS and RFI rule match rates for 30 days
  3. If false-positive rate exceeds 1% of legitimate requests, add URI-based scope-down statements excluding AI content endpoints from `CrossSiteScripting_BODY` and `GenericRFI_BODY`
  4. Consider switching these rules to count-only mode for AI endpoints during the monitoring period
- **Effort:** Medium — requires monitoring period, potential rule exclusion, and validation
- **Cross-References:** §10 NW-H2 (SizeRestrictions dependency), §10 NW-H3 (logging prerequisite)
- **Status:** New

---

#### NW-L1: No Geo-Restriction at WAF Layer

- **Severity:** Low
- **Section:** 10. WAF Rule Effectiveness Analysis
- **Current State:** Neither WAF ACL contains a geographic restriction rule. The platform serves Canadian legal education users but accepts traffic from all countries.
- **Gap:** From an OWASP A01 (Broken Access Control) perspective, geographic access control is a defense-in-depth layer. The absence of geo-restriction means attack traffic can originate from any country without additional filtering.
- **Risk:** Low severity because: (1) authentication via Cognito is required for all functional endpoints, (2) the platform does not contain data that is illegal to access from outside Canada, (3) geo-restriction can be easily bypassed via VPN. The primary benefit is reducing attack surface from automated scanning originating from high-attack-volume regions.
- **Recommendation:** This is covered in detail in §4 NW-H2 (CloudFront geo-restriction). From the WAF effectiveness perspective, geo-restriction is a defense-in-depth measure that reduces noise rather than preventing determined attackers.
- **Effort:** Low — CDK configuration
- **Cross-References:** §4 NW-H2 (CloudFront WAF geo-restriction finding)
- **Status:** New

---

## 11. Production Readiness Recommendations

> *Requirement 10: Document Network Segmentation Recommendations for Production Readiness*

This section assesses whether the current network architecture is production-ready, evaluating subnet isolation, Network ACLs, VPC endpoints, and the need for advanced traffic inspection. Recommendations include a cost-benefit analysis for VPC endpoints and a recommended network architecture diagram specification.

### 11.1 Subnet Architecture Sufficiency

**Current Architecture:** 3-tier subnet model (public, private-with-egress, private-isolated) with `maxAzs: 2` and `natGateways: 1`.

**Assessment: The 3-tier architecture is sufficient for current scale but lacks functional isolation between workload types.**

| Aspect | Current State | Production Readiness |
|--------|--------------|---------------------|
| Tier separation | 3 tiers defined in CDK | ✅ Correct conceptual model |
| Database isolation | RDS in PRIVATE_ISOLATED | ✅ No internet route (new VPC path) |
| Lambda placement | All Lambdas in PRIVATE_WITH_EGRESS | ⚠️ No distinction between AI-heavy and lightweight functions |
| AI Lambda isolation | Mixed with REST handlers | ⚠️ AI functions share subnet/SG with non-AI functions |
| Inter-tier traffic control | Security groups only | ⚠️ No NACL layer; SG uses VPC-wide CIDR (NW-H1 §3) |

**Should AI Lambda functions have a separate subnet?**

Separate subnets for AI Lambdas (text generation, summary generation, playground, assess progress, case generation) would provide:

1. **Independent scaling of NAT capacity** — AI Lambdas generate the bulk of NAT traffic (Bedrock API calls with large payloads). Isolating them enables targeted NAT Gateway sizing.
2. **Blast radius containment** — A compromised AI Lambda with access to Bedrock cannot pivot to other Lambda functions' network resources.
3. **Targeted monitoring** — Flow log analysis can be scoped to the AI subnet for Bedrock traffic anomaly detection.

However, the **added complexity is not justified at current scale** for several reasons:

- CDK does not natively support more than 3 subnet tiers without custom subnet constructs
- The primary isolation gap (VPC-wide CIDR SG on RDS) exists regardless of subnet separation
- The real isolation benefit comes from **security group segmentation** (dedicated Lambda client SG), not additional subnets
- Once VPC endpoints for Bedrock are provisioned, AI Lambdas no longer require NAT access at all

**Recommendation:** Do not add a 4th subnet tier. Instead:
1. Create a dedicated **Lambda client security group** (separate from the RDS SG) with scoped egress rules per function group
2. Provision a **Bedrock Runtime VPC endpoint** — this removes the NAT dependency for AI functions entirely
3. Revisit subnet separation only if the platform scales beyond ~50 concurrent AI sessions

**Code Reference:**
```typescript
// vpc-stack.ts lines 135-160 — current 3-tier definition
subnetConfiguration: [
  { name: "public-subnet-1", subnetType: ec2.SubnetType.PUBLIC },
  { name: "private-subnet-1", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  { name: "isolated-subnet-1", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
],
```

### 11.2 Network ACL Assessment

**Current State:** No Network ACLs (NACLs) are configured in `vpc-stack.ts`. All subnets use the **default VPC NACL**, which allows all inbound and outbound traffic on all ports.

**Code Evidence:**
```typescript
// vpc-stack.ts — No NACL constructs defined
// CDK default behavior: subnets inherit the VPC's default NACL (allow all)
```

**Assessment: NACLs provide a valuable stateless defense layer that complements security groups.**

| Layer | Current Status | Gap |
|-------|---------------|-----|
| Security Groups (stateful) | Configured, but VPC-wide CIDR on RDS SG | Overly permissive ingress |
| Network ACLs (stateless) | Default allow-all | No additional filtering |
| AWS Network Firewall | Not deployed | See §11.6 |

**Why NACLs add value for LAIGO:**

1. **Subnet-level deny rules** — NACLs can block traffic between subnets that security groups cannot (SGs only allow, they don't explicitly deny)
2. **Defense against SG misconfigurations** — If a security group rule is accidentally broadened, NACLs provide a backstop
3. **Compliance requirement** — Many legal/financial compliance frameworks (SOC 2, ISO 27001) require network-layer access controls at multiple levels
4. **Stateless protection** — NACLs operate independently of connection state, providing protection against SYN flood attacks at the network layer

**Recommended NACL Configuration:**

**Isolated Subnet NACL (RDS tier):**

| Rule # | Direction | Protocol | Port Range | Source/Dest | Action | Purpose |
|--------|-----------|----------|-----------|-------------|--------|---------|
| 100 | Inbound | TCP | 5432 | Private subnet CIDRs | ALLOW | PostgreSQL from Lambda subnets only |
| 110 | Inbound | TCP | 443 | Private subnet CIDRs | ALLOW | VPC endpoint traffic (HTTPS) |
| 200 | Inbound | TCP | 1024-65535 | Private subnet CIDRs | ALLOW | Ephemeral return traffic |
| * | Inbound | All | All | 0.0.0.0/0 | DENY | Default deny all other inbound |
| 100 | Outbound | TCP | 1024-65535 | Private subnet CIDRs | ALLOW | Response traffic to Lambda |
| 110 | Outbound | TCP | 443 | Private subnet CIDRs | ALLOW | VPC endpoint return traffic |
| * | Outbound | All | All | 0.0.0.0/0 | DENY | Default deny all outbound |

**Private-with-Egress Subnet NACL (Lambda tier):**

| Rule # | Direction | Protocol | Port Range | Source/Dest | Action | Purpose |
|--------|-----------|----------|-----------|-------------|--------|---------|
| 100 | Inbound | TCP | 1024-65535 | 0.0.0.0/0 | ALLOW | Return traffic from NAT/internet |
| 110 | Inbound | TCP | 443 | VPC CIDR | ALLOW | VPC endpoint and intra-VPC HTTPS |
| 120 | Inbound | TCP | 5432 | Isolated subnet CIDRs | ALLOW | RDS response traffic |
| * | Inbound | All | All | 0.0.0.0/0 | DENY | Default deny |
| 100 | Outbound | TCP | 443 | 0.0.0.0/0 | ALLOW | HTTPS to AWS services (Bedrock, etc.) |
| 110 | Outbound | TCP | 5432 | Isolated subnet CIDRs | ALLOW | Database connections |
| 120 | Outbound | TCP | 1024-65535 | 0.0.0.0/0 | ALLOW | Ephemeral response traffic |
| * | Outbound | All | All | 0.0.0.0/0 | DENY | Default deny |

**Implementation Effort:** Low — CDK `ec2.NetworkAcl` construct with `ec2.NetworkAclEntry` resources. No code changes to application functions required.

**CDK Implementation Pattern:**
```typescript
const isolatedNacl = new ec2.NetworkAcl(this, 'IsolatedSubnetNacl', {
  vpc: this.vpc,
  subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
});

isolatedNacl.addEntry('AllowPostgresInbound', {
  ruleNumber: 100,
  cidr: ec2.AclCidr.ipv4('10.0.64.0/18'), // Private subnet CIDR range
  traffic: ec2.AclTraffic.tcpPort(5432),
  direction: ec2.TrafficDirection.INGRESS,
  ruleAction: ec2.Action.ALLOW,
});
// ... additional rules
```

### 11.3 PrivateLink / VPC Endpoint Recommendations

**Current State:** Only 2 VPC endpoints provisioned (Secrets Manager and RDS, both interface type, in isolated subnets). All other AWS service traffic traverses the single NAT Gateway.

**Assessment of services currently accessed via NAT Gateway:**

| Service | Current Access | Traffic Volume | Latency Sensitivity | Data Sensitivity | Recommendation |
|---------|---------------|---------------|--------------------|--------------------|----------------|
| **Amazon Bedrock Runtime** | NAT → Internet | **High** — every AI chat message, summary, assessment, case generation (large request/response payloads 5–50 KB per call) | High — user-facing streaming responses | High — contains legal case content | **Add VPC Endpoint (Interface)** |
| **Amazon S3** | NAT → Internet | Medium — audio file uploads/downloads, pre-signed URL generation, whitelist CSV uploads | Medium | High — audio recordings, legal documents | **Add VPC Endpoint (Gateway — free)** |
| **Amazon DynamoDB** | NAT → Internet | Medium — chat history reads/writes, WebSocket connection tracking, notification storage | High — real-time chat flow | Medium — conversation metadata | **Add VPC Endpoint (Gateway — free)** |
| **CloudWatch Logs** | NAT → Internet | **High** — every Lambda invocation emits logs (13+ VPC-connected functions) | Low | Low — operational logs | **Add VPC Endpoint (Interface)** |
| **Amazon Transcribe** | NAT → Internet | Low-Medium — audio transcription jobs (bounded by audio upload frequency) | Low — async processing | High — audio content | **Defer** — evaluate after Bedrock endpoint |
| **Amazon EventBridge** | NAT → Internet | Low — notification events only (case status changes, feedback) | Low | Low — event metadata | **Defer** — minimal traffic volume |
| **Amazon SES** | NAT → Internet | Very Low — email verification codes, notifications | Low | Low — transactional email | **Defer** — negligible traffic |
| **AWS SSM Parameter Store** | NAT → Internet | Low — config reads on Lambda cold starts and warm-start refreshes | Medium — affects cold start time | Low — config values | **Consider** — reduces cold start latency |

**Priority Order for VPC Endpoint Deployment:**

| Priority | Service | Type | Justification |
|----------|---------|------|---------------|
| **P1** | Amazon S3 | Gateway | **Free** (no hourly or data charges). Immediate cost savings. Removes NAT dependency for audio uploads and CSV processing. |
| **P2** | Amazon DynamoDB | Gateway | **Free** (no hourly or data charges). Removes NAT dependency for real-time chat history and notifications. |
| **P3** | Amazon Bedrock Runtime | Interface | Eliminates NAT SPOF for all AI features. Highest-impact change for reliability. Keeps legal case content off public internet path. |
| **P4** | CloudWatch Logs | Interface | Reduces NAT bandwidth consumption (high-volume logging from 13+ functions). Improves log delivery reliability during NAT issues. |
| **P5** | Amazon Transcribe | Interface | Defer until post-P3. Low traffic volume; evaluate cost-benefit after Bedrock endpoint is operational. |
| **P6** | EventBridge | Interface | Defer indefinitely. Low traffic volume does not justify $7.20/month baseline cost. |
| **P7** | SES | Interface | Defer indefinitely. Negligible traffic; SES operates outside VPC for most configurations. |

**Subnet Placement Note:** All new VPC endpoints should be placed in `PRIVATE_WITH_EGRESS` subnets (where Lambda consumers reside), not `PRIVATE_ISOLATED` — correcting the architectural issue identified in §2 finding NW-M2.

### 11.4 VPC Endpoint Cost-Benefit Analysis

**Cost Model (ca-central-1 pricing):**

| Cost Component | NAT Gateway | Interface VPC Endpoint | Gateway VPC Endpoint |
|----------------|------------|------------------------|---------------------|
| Hourly charge | $0.045/hr ($32.40/mo) | $0.01/hr per AZ per endpoint ($7.20/mo per endpoint × 2 AZs = $14.40/mo) | **$0.00** |
| Data processing | $0.045/GB | $0.01/GB (first 1 PB) | **$0.00** |
| Already deployed | 1 NAT Gateway ($32.40/mo baseline) | — | — |

**Traffic Volume Estimates (monthly, production steady-state):**

| Service | Estimated Monthly Data Transfer | NAT Cost | VPC Endpoint Cost | Monthly Savings |
|---------|-------------------------------|----------|-------------------|-----------------|
| S3 (audio + CSV) | ~20 GB | $0.90 | $0.00 (gateway) | **$0.90** |
| DynamoDB | ~5 GB | $0.23 | $0.00 (gateway) | **$0.23** |
| Bedrock Runtime | ~50 GB (large prompt/response payloads) | $2.25 | $14.40 (endpoint) + $0.50 (data) = $14.90 | **-$12.65** (net cost increase) |
| CloudWatch Logs | ~30 GB | $1.35 | $14.40 (endpoint) + $0.30 (data) = $14.70 | **-$13.35** (net cost increase) |
| SSM Parameter Store | <1 GB | ~$0.00 | $14.40 (endpoint) | **-$14.40** (net cost increase) |
| Transcribe | ~10 GB | $0.45 | $14.40 (endpoint) + $0.10 (data) = $14.50 | **-$14.05** (net cost increase) |

**Summary: Cost alone does not justify most interface endpoints. The value is in reliability and security.**

| Endpoint | Monthly Net Cost Impact | Reliability Benefit | Security Benefit | Verdict |
|----------|------------------------|--------------------|--------------------|---------|
| **S3 (Gateway)** | **Saves $0.90/mo** | Removes NAT dependency for file ops | Data stays on AWS backbone | ✅ **Deploy immediately** (free) |
| **DynamoDB (Gateway)** | **Saves $0.23/mo** | Removes NAT dependency for real-time features | Data stays on AWS backbone | ✅ **Deploy immediately** (free) |
| **Bedrock Runtime** | **+$12.65/mo** | **Eliminates NAT SPOF for all AI features** — platform's core value | Legal case content never traverses public internet | ✅ **Deploy** — reliability justifies cost |
| **CloudWatch Logs** | **+$13.35/mo** | Logging resilient to NAT failures; improves debuggability during outages | Minimal security benefit | ⚠️ **Deploy if budget allows** — good for incident response |
| **Transcribe** | **+$14.05/mo** | Low frequency; NAT loss is tolerable (async job) | Audio content stays on backbone | ❌ **Defer** — cost not justified by volume |
| **EventBridge** | **+$14.40/mo** | Low frequency; notifications can tolerate brief delays | Minimal | ❌ **Defer** |
| **SES** | **+$14.40/mo** | Negligible traffic | Minimal | ❌ **Defer** |

**Total recommended spend:** Gateway endpoints (S3 + DynamoDB) = **$0/mo additional**. Bedrock Runtime = **~$14.90/mo**. CloudWatch Logs (optional) = **~$14.70/mo**.

**Comparison with 2-NAT production setup:** Adding a second NAT Gateway for HA (NW-H1 §2) costs **$32.40/mo**. Deploying Bedrock + S3 + DynamoDB endpoints at **$14.90/mo** provides better reliability for AI features while **reducing** NAT traffic volume, potentially making the second NAT less urgent for non-AI workloads.

### 11.5 Network Architecture Diagram Recommendation

**Current State:** No network architecture diagram exists documenting traffic flows, trust boundaries, or encryption points. The CDK code is the only reference for understanding network topology.

**Recommendation:** Create and maintain a network architecture diagram (in Mermaid or draw.io format, stored in `docs/architecture/`) documenting:

**Required Diagram Elements:**

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ RECOMMENDED NETWORK ARCHITECTURE DIAGRAM CONTENT                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  TRUST BOUNDARIES:                                                              │
│  ─────────────────                                                              │
│  [1] Internet ←→ CloudFront (WAF: CloudFront ACL)                               │
│  [2] CloudFront ←→ API Gateway (WAF: Regional ACL)                              │
│  [3] API Gateway ←→ Lambda (VPC boundary, Lambda authorizer)                    │
│  [4] Lambda ←→ RDS Proxy (Security group + TLS)                                 │
│  [5] RDS Proxy ←→ RDS (TLS, same security group)                                │
│  [6] Lambda ←→ AWS Services (VPC endpoint or NAT)                               │
│                                                                                 │
│  TRAFFIC FLOWS:                                                                 │
│  ──────────────                                                                 │
│  • Client → CloudFront → API GW → Lambda → RDS (data path)                     │
│  • Lambda → Bedrock (AI inference, via NAT or VPC endpoint)                     │
│  • Lambda → DynamoDB (chat history, via NAT or VPC endpoint)                    │
│  • Lambda → S3 (audio storage, via NAT or VPC endpoint)                         │
│  • Lambda → Transcribe (audio processing, via NAT)                              │
│  • Lambda → EventBridge → NotificationLambda → WebSocket API (notifications)    │
│  • Lambda → Secrets Manager (credentials, via VPC endpoint in isolated subnet)  │
│  • Lambda → SSM Parameter Store (config, via NAT)                               │
│  • Lambda → CloudWatch Logs (logging, via NAT)                                  │
│                                                                                 │
│  ENCRYPTION POINTS:                                                             │
│  ─────────────────                                                              │
│  • Client → CloudFront: TLS 1.2+ (AWS-managed certificate)                     │
│  • CloudFront → API GW: TLS 1.2 (regional endpoint)                            │
│  • API GW → Lambda: AWS internal (not user-configurable)                        │
│  • Lambda → RDS Proxy: TLS required (requireTLS: true)                          │
│  • RDS Proxy → RDS: TLS (rds.force_ssl: 1)                                     │
│  • Lambda → AWS Services: TLS 1.2 (AWS SDK default)                            │
│  • RDS storage: AES-256 (storageEncrypted: true, SSE-S3)                        │
│  • S3 objects: SSE-S3                                                           │
│  • DynamoDB: AWS-managed encryption at rest                                     │
│                                                                                 │
│  SUBNET LAYOUT:                                                                 │
│  ──────────────                                                                 │
│  ┌──── Public Subnet (1 AZ) ────┐                                              │
│  │  NAT Gateway + EIP           │                                               │
│  └──────────────────────────────┘                                               │
│  ┌──── Private-with-Egress (2 AZs) ────┐                                       │
│  │  Lambda functions (all 13+)          │                                       │
│  │  Route: 0.0.0.0/0 → NAT             │                                       │
│  └──────────────────────────────────────┘                                       │
│  ┌──── Private-Isolated (2 AZs) ────┐                                          │
│  │  RDS PostgreSQL + RDS Proxy       │                                          │
│  │  VPC Endpoints (SecretsManager, RDS) │                                       │
│  │  No internet route                │                                          │
│  └───────────────────────────────────┘                                          │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Diagram Format Recommendation:** Use Mermaid (version-controlled in markdown) with a companion PNG export for non-technical stakeholders. Store at `docs/architecture/network-architecture.md`.

**Maintenance Trigger:** Update the diagram whenever:
- A VPC endpoint is added or removed
- NAT Gateway configuration changes (HA upgrade)
- A new Lambda function is added to the VPC
- Security group rules are modified
- NACLs are introduced

### 11.6 AWS Network Firewall Assessment

**Current State:** No AWS Network Firewall is deployed. Network perimeter protection relies on:
- WAF (CloudFront-scoped + API Gateway-scoped) for application-layer filtering
- Security groups for network-layer access control
- No NACLs beyond default allow-all

**AWS Network Firewall Capabilities vs Current Controls:**

| Capability | AWS Network Firewall | Current Coverage (WAF + SGs) | Gap? |
|-----------|---------------------|------------------------------|------|
| Layer 7 HTTP/HTTPS inspection | ✅ Suricata-compatible IDS/IPS rules | ✅ WAF provides L7 filtering for HTTP | No |
| Domain-based egress filtering | ✅ Can restrict outbound to specific FQDNs | ❌ Lambda egress is unrestricted (0.0.0.0/0) | **Yes** |
| TLS Server Name Indication (SNI) filtering | ✅ Filter by destination domain without decryption | ❌ Not available with WAF + SGs alone | **Yes** |
| Stateful packet inspection | ✅ Full TCP state tracking | ✅ Security groups are stateful | No |
| Network-level IDS/IPS | ✅ Suricata rules for known malicious patterns | ❌ Not available | **Yes** |
| Protocol anomaly detection | ✅ Detect malformed packets | ❌ Not available at current layer | Yes (low risk) |
| Centralized egress logging/filtering | ✅ All outbound traffic can be inspected | ⚠️ VPC Flow Logs capture metadata only, not content | **Partial** |
| Rate limiting | ✅ At network level | ✅ WAF rate limits at application level | No |
| Geo-blocking | ❌ Not a Network Firewall feature | ⚠️ Missing on CloudFront WAF (NW-H2 §4) | N/A |

**Cost Analysis:**

| Component | Estimated Monthly Cost |
|-----------|----------------------|
| Network Firewall endpoint (per AZ) | $0.395/hr × 730 hrs = **$288.35/mo per AZ** |
| Data processing | $0.065/GB |
| **2-AZ deployment** | **~$576.70/mo + data processing** |

**Assessment: AWS Network Firewall is NOT warranted for the current threat model.**

**Rationale:**

1. **Cost disproportionate to risk:** $577+/mo for a platform with a small user base (legal education) is difficult to justify when the primary threat vectors (web application attacks, credential stuffing) are already addressed by WAF.

2. **Primary gap (domain-based egress filtering) can be addressed cheaper:** The main benefit of Network Firewall — restricting Lambda outbound to specific AWS service domains — can be partially achieved by:
   - Adding VPC endpoints (Bedrock, S3, DynamoDB) to keep traffic off the internet entirely
   - Applying restrictive security group egress rules on Lambda functions (port 443 to specific CIDR prefixes)

3. **IDS/IPS value is low for this architecture:** Lambda functions are ephemeral (no persistent compromise vector), RDS is in an isolated subnet, and all traffic enters through API Gateway with WAF protection. The attack surface for network-level exploits is minimal.

4. **WAF + VPC endpoints + NACLs provide sufficient defense-in-depth** for a legal education platform:
   - WAF blocks application-layer attacks at the perimeter
   - VPC endpoints eliminate internet traversal for core services
   - NACLs provide stateless subnet-level filtering
   - Security groups (once tightened) restrict port-level access

**When to reconsider Network Firewall:**
- Platform handles **classified or government-regulated data** requiring certified network inspection
- **Compliance audit** explicitly requires IDS/IPS capabilities (NIST 800-53 SC-7)
- Platform scales to **hundreds of concurrent users** with significantly higher attack surface
- A **security incident** occurs that would have been prevented by egress domain filtering

**Alternative: Implement domain-based egress control without Network Firewall:**
- Deploy VPC endpoints for all high-traffic services (removes need for internet egress)
- Restrict Lambda security group egress to port 443 only (to VPC endpoint ENI security groups or specific AWS CIDR ranges via prefix lists)
- Use VPC Flow Logs with custom CloudWatch Insights queries to detect unexpected outbound destinations

### Findings

| ID | Title | Severity | Effort | Status |
|----|-------|----------|--------|--------|
| NW-M1 | No Network ACLs configured — reliance on security groups alone for subnet isolation | Medium | Low | New |
| NW-M2 | Missing free VPC Gateway endpoints for S3 and DynamoDB increases NAT cost and failure blast radius | Medium | Low | New |
| NW-M3 | No Bedrock Runtime VPC endpoint — core AI features dependent on NAT Gateway for all requests | Medium | Medium | New |
| NW-M4 | No network architecture diagram documenting traffic flows, trust boundaries, and encryption points | Medium | Low | New |
| NW-L1 | CloudWatch Logs VPC endpoint not provisioned — logging depends on NAT availability | Low | Low | New |
| NW-L2 | AWS Network Firewall not deployed (accepted risk — WAF + SGs + endpoints deemed sufficient for current threat model) | Low | High | Deferred |

---

#### NW-M1: No Network ACLs configured — default allow-all on all subnets

- **Severity:** Medium
- **Section:** Production Readiness Recommendations
- **Current State:** No `ec2.NetworkAcl` or `ec2.NetworkAclEntry` constructs exist in `vpc-stack.ts`. All subnets use the VPC default NACL which permits all inbound and outbound traffic.
- **Code Evidence:**
  ```typescript
  // vpc-stack.ts — No NACL configuration anywhere in the file
  // Subnets inherit default VPC NACL (allow all inbound/outbound)
  ```
- **Gap:** NACLs provide a stateless defense layer independent of security groups. Without them, a misconfigured security group is the sole network-level control. This violates defense-in-depth principles required by compliance frameworks (SOC 2, ISO 27001).
- **Risk:** If the RDS security group is accidentally broadened (e.g., during debugging), no fallback prevents unauthorized database access from non-Lambda subnets. NACLs would block traffic regardless of SG misconfiguration.
- **Recommendation:** Add NACLs to PRIVATE_ISOLATED subnets restricting inbound to TCP/5432 and TCP/443 from private subnet CIDRs only. Add NACLs to PRIVATE_WITH_EGRESS subnets restricting outbound to TCP/443 (HTTPS) and TCP/5432 (PostgreSQL). See §11.2 for detailed rule specification.
- **Effort:** Low
- **Cross-References:** NW-H1 (§3, VPC-wide CIDR SG), RDS-H2
- **Status:** New

---

#### NW-M2: Missing free Gateway endpoints for S3 and DynamoDB

- **Severity:** Medium
- **Section:** Production Readiness Recommendations
- **Current State:** No S3 or DynamoDB Gateway VPC endpoints are provisioned. All S3 and DynamoDB traffic from Lambda functions traverses the NAT Gateway.
- **Code Evidence:**
  ```typescript
  // vpc-stack.ts — Only interface endpoints for Secrets Manager and RDS
  this.vpc.addInterfaceEndpoint(`${id}-Secrets Manager Endpoint`, { ... });
  this.vpc.addInterfaceEndpoint(`${id}-RDS Endpoint`, { ... });
  // No Gateway endpoints (S3, DynamoDB) — these are FREE
  ```
- **Gap:** Gateway VPC endpoints for S3 and DynamoDB have **zero cost** (no hourly charge, no data processing charge). Their absence means Lambda functions pay NAT data processing fees ($0.045/GB) for every S3 object access and DynamoDB operation, and these operations fail during NAT Gateway outages.
- **Risk:** Unnecessary NAT Gateway cost ($1.13/mo estimated), increased NAT SPOF blast radius (audio uploads, chat history, notifications all fail during NAT issues), and data traverses an unnecessary internet-adjacent path when a free private path is available.
- **Recommendation:** Add both Gateway endpoints immediately:
  ```typescript
  this.vpc.addGatewayEndpoint(`${id}-S3-Endpoint`, {
    service: ec2.GatewayVpcEndpointAwsService.S3,
    subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
  });
  this.vpc.addGatewayEndpoint(`${id}-DynamoDB-Endpoint`, {
    service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
  });
  ```
- **Effort:** Low
- **Cross-References:** NW-M1 (§2), NW-H1 (§2, NAT SPOF)
- **Status:** New

---

#### NW-M3: No Bedrock Runtime VPC endpoint — AI features depend on NAT Gateway

- **Severity:** Medium
- **Section:** Production Readiness Recommendations
- **Current State:** All 5 AI Lambda functions (text generation, playground, summary, case generation, assess progress) access Amazon Bedrock Runtime via the single NAT Gateway.
- **Code Evidence:**
  ```typescript
  // api-stack.ts — AI Lambdas in VPC with no Bedrock endpoint
  const textGenLambdaDockerFunc = new lambda.DockerImageFunction(this, ..., {
    vpc: vpcStack.vpc,  // In VPC, but Bedrock traffic exits via NAT
    // No Bedrock VPC endpoint provisioned
  });
  // vpc-stack.ts — No Bedrock endpoint defined
  ```
- **Gap:** Amazon Bedrock Runtime supports VPC interface endpoints (`bedrock-runtime`). Without one, every AI request (chat messages, summaries, progress assessments, case generation) traverses: Lambda → NAT Gateway → Internet → Bedrock. This introduces unnecessary latency, NAT dependency, and routes legal case content through a public internet path.
- **Risk:** (1) NAT Gateway failure (NW-H1 §2) takes down **all AI features** simultaneously — the platform's core value proposition. (2) Legal case content (potentially privileged attorney-client information) traverses the public internet path between NAT and Bedrock endpoint rather than staying on the AWS private backbone. (3) Added latency on streaming AI responses (user-facing impact).
- **Recommendation:** Add Bedrock Runtime VPC interface endpoint in `PRIVATE_WITH_EGRESS` subnets:
  ```typescript
  this.vpc.addInterfaceEndpoint(`${id}-Bedrock-Runtime-Endpoint`, {
    service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
    subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    privateDnsEnabled: true,
  });
  ```
  Estimated cost: ~$14.90/mo (2 AZs × $7.20 + data processing). This is less than half the cost of a second NAT Gateway ($32.40/mo) while providing better AI feature resilience.
- **Effort:** Medium (requires testing to verify Lambda SDK uses private DNS correctly)
- **Cross-References:** NW-H1 (§2, NAT SPOF), NW-M1 (§2, missing endpoints), CDK-H4, WA-H2
- **Status:** New

---

#### NW-M4: No network architecture diagram exists

- **Severity:** Medium
- **Section:** Production Readiness Recommendations
- **Current State:** No diagram documents the network architecture, traffic flows, trust boundaries, or encryption points. The CDK source code in `vpc-stack.ts`, `database-stack.ts`, and `api-stack.ts` is the sole reference.
- **Gap:** Without a visual network diagram, security reviews, incident response, and onboarding require code-level analysis to understand traffic flows. Compliance audits (SOC 2, ISO 27001) typically require documented network architecture diagrams.
- **Risk:** Slower incident response (responders must trace CDK code to understand connectivity), increased risk of security misconfigurations going undetected (no visual reference for intended vs actual architecture), and potential compliance gaps.
- **Recommendation:** Create `docs/architecture/network-architecture.md` with a Mermaid diagram covering all elements specified in §11.5. Include trust boundaries, encryption enforcement points, and subnet placement. Update on any network infrastructure change. Export PNG for non-technical stakeholders.
- **Effort:** Low (documentation only, no code changes)
- **Cross-References:** —
- **Status:** New

---

#### NW-L1: CloudWatch Logs VPC endpoint not provisioned

- **Severity:** Low
- **Section:** Production Readiness Recommendations
- **Current State:** All Lambda function logging (13+ VPC-connected functions) routes through the NAT Gateway to reach CloudWatch Logs.
- **Code Evidence:**
  ```typescript
  // vpc-stack.ts — No CloudWatch Logs endpoint
  // All Lambda log shipping traverses NAT
  ```
- **Gap:** During a NAT Gateway failure, Lambda functions continue executing but logs are not delivered to CloudWatch. This creates a visibility gap precisely when visibility is most needed (during an outage).
- **Risk:** Loss of observability during NAT failures. Debugging a NAT outage becomes harder because the logs that would show the impact are themselves affected. Estimated ~30 GB/mo of log traffic adds ~$1.35/mo NAT data processing cost.
- **Recommendation:** Add CloudWatch Logs interface endpoint. Lower priority than Bedrock and Gateway endpoints. Cost: ~$14.70/mo. Deploy only if operational visibility during outages is a priority.
  ```typescript
  this.vpc.addInterfaceEndpoint(`${id}-CW-Logs-Endpoint`, {
    service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    privateDnsEnabled: true,
  });
  ```
- **Effort:** Low
- **Cross-References:** NW-H1 (§2, NAT SPOF)
- **Status:** New

---

#### NW-L2: AWS Network Firewall not deployed (accepted risk)

- **Severity:** Low
- **Section:** Production Readiness Recommendations
- **Current State:** No AWS Network Firewall is deployed. Network perimeter protection relies on WAF (2 ACLs) + security groups + VPC Flow Logs.
- **Gap:** No domain-based egress filtering, no IDS/IPS capabilities, no TLS SNI inspection. Lambda functions can reach any internet destination on port 443 without content inspection.
- **Risk:** A compromised Lambda function could exfiltrate data to arbitrary internet destinations. However, this requires first compromising a Lambda (ephemeral, minimal attack surface), then bypassing WAF rate limits and CloudWatch anomaly detection (once implemented). The residual risk is low for the current threat model (legal education, small user base).
- **Recommendation:** **Defer.** The cost (~$577/mo minimum) is disproportionate to the residual risk for a legal education platform. Instead, implement: (1) VPC endpoints to eliminate most internet egress, (2) restrictive security group egress rules, (3) VPC Flow Log anomaly detection via CloudWatch Insights. Revisit if compliance requirements change or a security incident occurs.
- **Effort:** High (architectural change, $577+/mo ongoing cost)
- **Cross-References:** —
- **Status:** Deferred

---

## 12. Prioritized Remediation Roadmap

> *All 48 findings aggregated, de-duplicated, and assigned global NW-* IDs. Ranked by severity descending, then effort ascending.*

### Global Finding ID Assignment

Findings are assigned global sequential IDs within each severity tier: `NW-H1` through `NW-H16` (High), `NW-M1` through `NW-M24` (Medium), `NW-L1` through `NW-L8` (Low). No Critical findings were identified.

---

### Immediate Actions (High Severity + Low Effort)

These 11 findings represent the highest-impact, lowest-cost remediations. All are configuration-only changes achievable within 1-2 days each.

| Priority | Global ID | Title | Section | Effort | Status | Cross-Refs |
|----------|-----------|-------|---------|--------|--------|------------|
| 1 | NW-H1 | No WAF logging on CloudFront WAF — zero incident response capability | §4, §7 | Low | New | — |
| 2 | NW-H2 | No WAF logging on API Gateway WAF — zero incident response capability | §5, §7 | Low | New | — |
| 3 | NW-H3 | No CloudWatch Alarms for network security anomalies (WAF, NAT, Flow Logs, API GW) | §7 | Low | New | WA-H1 |
| 4 | NW-H4 | Certificate validation disabled (`rejectUnauthorized: false`) in REST API database connections | §6 | Low | New | RDS-H3 |
| 5 | NW-H5 | Python AI Lambda functions missing explicit `sslmode` in database connections (4 functions) | §6 | Low | New | — |
| 6 | NW-H6 | `AWSManagedRulesCommonRuleSet` `SizeRestrictions_BODY` (8 KB) blocks legitimate legal content | §5, §10 | Low | New | — |
| 7 | NW-H7 | Single NAT Gateway creates AZ single point of failure for 13+ Lambda functions | §2 | Low | Open | CDK-H4, WA-H2 |
| 8 | NW-H8 | No geo-restriction on CloudFront WAF — Canadian-only platform exposed to global attack traffic | §4 | Low | New | — |
| 9 | NW-H9 | `dataTraceEnabled: true` logs privileged legal content (attorney-client) to CloudWatch | §8 | Low | New | S-H4, CDK-M2 |
| 10 | NW-H10 | OWASP coverage gaps — no KnownBadInputsRuleSet, IpReputationList, or SQLiRuleSet | §4, §10 | Low | New | — |
| 11 | NW-H11 | No WAF logging prevents OWASP A09 (Security Logging and Monitoring) compliance | §10 | Low | New | — |

---

### Short-Term (High Severity + Medium Effort)

These 5 findings require coordinated code or infrastructure changes across multiple files, testing in staging, and rollback planning. Target: 1-5 days each.

| Priority | Global ID | Title | Section | Effort | Status | Cross-Refs |
|----------|-----------|-------|---------|--------|--------|------------|
| 12 | NW-H12 | VPC-wide CIDR ingress on RDS security group violates least-privilege | §3 | Medium | Open | RDS-H2 |
| 13 | NW-H13 | Control Tower path uses same subnet IDs for private and isolated tiers | §2 | Medium | New | — |
| 14 | NW-H14 | Open networking findings from prior reviews remain unresolved (6 High-severity) | §9 | Low–Med | Open | CDK-H4, WA-H2, RDS-H2, WA-H1, Node-H3, S-H4 |
| 15 | NW-H15 | Rate limit false-positive risk compounded by missing CAPTCHA (CloudFront WAF) | §4 | Medium | New | — |
| 16 | NW-H16 | Inconsistent security group assignment pattern across Lambda functions | §3 | Medium | New | RDS-H2 |

---

### Medium-Term (Medium Severity)

These 24 findings represent defense-in-depth gaps and operational improvements. Organized by sub-priority (effort ascending within group).

| Priority | Global ID | Title | Section | Effort | Status | Cross-Refs |
|----------|-----------|-------|---------|--------|--------|------------|
| 17 | NW-M1 | Missing free VPC Gateway endpoints for S3 and DynamoDB | §2, §11 | Low | New | — |
| 18 | NW-M2 | VPC endpoints placed in PRIVATE_ISOLATED not accessible from Lambda subnets | §2 | Low | New | — |
| 19 | NW-M3 | Database migration Lambda uses `rejectUnauthorized: false` | §6 | Low | New | NW-H4 |
| 20 | NW-M4 | VPC Flow Log uses default format — missing TCP flags, subnet-id, flow-direction | §7 | Low | New | — |
| 21 | NW-M5 | VPC Flow Log retention not explicitly configured (unbounded cost growth) | §7 | Low | New | — |
| 22 | NW-M6 | No centralized security monitoring dashboard | §7 | Low | New | — |
| 23 | NW-M7 | Playground generation Lambda has unnecessary database network connectivity | §3 | Low | New | — |
| 24 | NW-M8 | AI endpoints lack targeted rate limiting — 200 req/5min vs 30 needed | §10 | Low | New | — |
| 25 | NW-M9 | Pre-signed URL endpoint allows bulk generation (200/5min vs 50 threshold) | §10 | Low | New | — |
| 26 | NW-M10 | No Network ACLs configured — default allow-all on all subnets | §11 | Low | New | — |
| 27 | NW-M11 | No network architecture diagram documenting traffic flows and trust boundaries | §11 | Low | New | — |
| 28 | NW-M12 | WebSocket API not associated with WAF — connection-level inspection missing | §5 | Low | New | — |
| 29 | NW-M13 | Missing KnownBadInputs and IpReputation rule groups on CloudFront WAF | §4 | Low | New | — |
| 30 | NW-M14 | AWSManagedRulesSQLiRuleSet not configured — defense-in-depth gap for RDS backend | §5 | Low | New | — |
| 31 | NW-M15 | Fixed networking findings from prior reviews warrant re-verification (5 findings) | §9 | Low | New | S-C1, S-H5, S-H3, Lambda-H3, S-M4 |
| 32 | NW-M16 | OpenAPI validator definition has syntax errors in key names | §8 | Low | New | — |
| 33 | NW-M17 | Rate limit threshold false-positive risk for shared-IP university networks (CloudFront) | §4 | Low | New | — |
| 34 | NW-M18 | Per-user rate limit bypassed on token refresh (new MD5 hash resets counter) | §5 | Medium | New | S-H1, S-H2 |
| 35 | NW-M19 | All VPC Lambda functions have unrestricted egress (0.0.0.0/0) | §3 | Medium | New | — |
| 36 | NW-M20 | Control Tower path adds NAT routes to isolated subnet route tables | §2 | Medium | New | NW-H13 |
| 37 | NW-M21 | Request body validation not enforced at API Gateway level | §8 | Medium | New | — |
| 38 | NW-M22 | WebSocket API lacks active stale connection termination | §8 | Medium | New | — |
| 39 | NW-M23 | No Bedrock Runtime VPC endpoint — AI features depend on NAT Gateway | §11 | Medium | New | CDK-H4, WA-H2 |
| 40 | NW-M24 | False-positive risk for legal content with XSS/RFI rules after SizeRestrictions exclusion | §10 | Medium | New | NW-H6 |

---

### Long-Term (Low Severity + Deferred Items)

These 8 findings are hardening opportunities, informational items, or deferred architectural decisions.

| Priority | Global ID | Title | Section | Effort | Status | Cross-Refs |
|----------|-----------|-------|---------|--------|--------|------------|
| 41 | NW-L1 | Private DNS disabled on Control Tower VPC endpoints | §2 | Low | New | — |
| 42 | NW-L2 | No explicit RDS CA bundle reference in connection configuration | §6 | Low | New | — |
| 43 | NW-L3 | No custom block response body — blocked users see generic 403 | §5 | Low | New | — |
| 44 | NW-L4 | WebSocket idle timeout and max duration rely on AWS defaults (undocumented) | §8 | Low | New | — |
| 45 | NW-L5 | CloudWatch Logs VPC endpoint not provisioned — logging depends on NAT | §11 | Low | New | NW-H7 |
| 46 | NW-L6 | No Bot Control managed rule group (deferred per cost-benefit) | §4 | Medium | New | — |
| 47 | NW-L7 | No geo-restriction at WAF layer for OWASP A01 supplemental control | §10 | Low | New | NW-H8 |
| 48 | NW-L8 | AWS Network Firewall not deployed (accepted risk — cost disproportionate) | §11 | High | Deferred | — |

---

### Complete Finding Index

| Global ID | Title | Severity | Effort | Section | Status | Cross-References |
|-----------|-------|----------|--------|---------|--------|-----------------|
| NW-H1 | No WAF logging on CloudFront WAF | High | Low | §4, §7 | New | — |
| NW-H2 | No WAF logging on API Gateway WAF | High | Low | §5, §7 | New | — |
| NW-H3 | No CloudWatch Alarms for network security anomalies | High | Low | §7 | New | WA-H1 |
| NW-H4 | Certificate validation disabled (`rejectUnauthorized: false`) in REST API handlers | High | Low | §6 | New | RDS-H3 |
| NW-H5 | Python AI Lambdas missing explicit `sslmode` in DB connections | High | Low | §6 | New | — |
| NW-H6 | SizeRestrictions_BODY (8 KB) blocks legitimate legal content | High | Low | §5, §10 | New | — |
| NW-H7 | Single NAT Gateway AZ single point of failure | High | Low | §2 | Open | CDK-H4, WA-H2 |
| NW-H8 | No geo-restriction on CloudFront WAF for Canadian platform | High | Low | §4 | New | — |
| NW-H9 | `dataTraceEnabled: true` logs privileged legal content to CloudWatch | High | Low | §8 | New | S-H4, CDK-M2 |
| NW-H10 | OWASP coverage gaps — missing KnownBadInputs, IpReputation, SQLi rule groups | High | Low | §4, §10 | New | — |
| NW-H11 | No WAF logging prevents OWASP A09 compliance | High | Low | §10 | New | — |
| NW-H12 | VPC-wide CIDR ingress on RDS security group violates least-privilege | High | Medium | §3 | Open | RDS-H2 |
| NW-H13 | Control Tower path reuses subnet IDs — private/isolated isolation broken | High | Medium | §2 | New | — |
| NW-H14 | Prior review networking findings unresolved (6 High-severity) | High | Low–Med | §9 | Open | CDK-H4, WA-H2, RDS-H2, WA-H1, Node-H3, S-H4 |
| NW-H15 | Rate limit hard block with no CAPTCHA for shared-IP environments | High | Medium | §4 | New | — |
| NW-H16 | Inconsistent SG assignment pattern across Lambda functions | High | Medium | §3 | New | RDS-H2 |
| NW-M1 | Missing free Gateway endpoints (S3, DynamoDB) | Medium | Low | §2, §11 | New | — |
| NW-M2 | VPC endpoints in PRIVATE_ISOLATED not optimally accessible from Lambdas | Medium | Low | §2 | New | — |
| NW-M3 | Migration Lambda uses `rejectUnauthorized: false` | Medium | Low | §6 | New | NW-H4 |
| NW-M4 | VPC Flow Log default format missing forensic fields | Medium | Low | §7 | New | — |
| NW-M5 | VPC Flow Log retention not explicitly configured | Medium | Low | §7 | New | — |
| NW-M6 | No centralized security monitoring dashboard | Medium | Low | §7 | New | — |
| NW-M7 | Playground Lambda has unnecessary DB connectivity | Medium | Low | §3 | New | — |
| NW-M8 | AI endpoints lack targeted rate limiting (200 vs 30 req/5min) | Medium | Low | §10 | New | — |
| NW-M9 | Pre-signed URL endpoint allows bulk generation (200 vs 50/5min) | Medium | Low | §10 | New | — |
| NW-M10 | No Network ACLs — default allow-all on all subnets | Medium | Low | §11 | New | — |
| NW-M11 | No network architecture diagram | Medium | Low | §11 | New | — |
| NW-M12 | WebSocket API not associated with WAF | Medium | Low | §5 | New | — |
| NW-M13 | Missing KnownBadInputs and IpReputation on CloudFront WAF | Medium | Low | §4 | New | — |
| NW-M14 | No SQLiRuleSet — defense-in-depth gap for RDS backend | Medium | Low | §5 | New | — |
| NW-M15 | Fixed findings warrant re-verification (5 environment-specific) | Medium | Low | §9 | New | S-C1, S-H5, S-H3, Lambda-H3, S-M4 |
| NW-M16 | OpenAPI validator syntax errors in key names | Medium | Low | §8 | New | — |
| NW-M17 | CloudFront rate limit false-positive risk for university networks | Medium | Low | §4 | New | — |
| NW-M18 | Per-user rate limit bypass via token refresh | Medium | Medium | §5 | New | S-H1, S-H2 |
| NW-M19 | All VPC Lambdas have unrestricted egress (0.0.0.0/0) | Medium | Medium | §3 | New | — |
| NW-M20 | Control Tower adds NAT routes to isolated subnet route tables | Medium | Medium | §2 | New | NW-H13 |
| NW-M21 | Request body validation not enforced at API Gateway level | Medium | Medium | §8 | New | — |
| NW-M22 | WebSocket lacks active stale connection termination | Medium | Medium | §8 | New | — |
| NW-M23 | No Bedrock Runtime VPC endpoint — AI on NAT | Medium | Medium | §11 | New | CDK-H4, WA-H2 |
| NW-M24 | False-positive risk for legal content after SizeRestrictions exclusion | Medium | Medium | §10 | New | NW-H6 |
| NW-L1 | Private DNS disabled on Control Tower VPC endpoints | Low | Low | §2 | New | — |
| NW-L2 | No explicit RDS CA bundle reference | Low | Low | §6 | New | — |
| NW-L3 | No custom WAF block response body | Low | Low | §5 | New | — |
| NW-L4 | WebSocket timeout/duration rely on AWS defaults | Low | Low | §8 | New | — |
| NW-L5 | CloudWatch Logs VPC endpoint not provisioned | Low | Low | §11 | New | NW-H7 |
| NW-L6 | No Bot Control rule group (deferred) | Low | Medium | §4 | New | — |
| NW-L7 | No geo-restriction for OWASP A01 supplemental control | Low | Low | §10 | New | NW-H8 |
| NW-L8 | AWS Network Firewall not deployed (accepted risk) | Low | High | §11 | Deferred | — |

---

### Remediation Effort Summary

| Category | Count | Estimated Total Effort |
|----------|-------|----------------------|
| Immediate Actions (High + Low Effort) | 11 findings | 5–8 engineering days |
| Short-Term (High + Medium Effort) | 5 findings | 8–15 engineering days |
| Medium-Term (Medium severity) | 24 findings | 20–40 engineering days |
| Long-Term (Low severity + Deferred) | 8 findings | 5–10 engineering days (excluding NW-L8) |
| **Total** | **48 findings** | **~38–73 engineering days** |

### Recommended Sprint Allocation

| Sprint | Focus | Findings |
|--------|-------|----------|
| Sprint 1 (Week 1-2) | Observability foundation | NW-H1, NW-H2, NW-H3, NW-H11 (WAF logging + Alarms) |
| Sprint 2 (Week 2-3) | TLS + functional fix | NW-H4, NW-H5, NW-H6, NW-H9, NW-M3 (TLS fixes + SizeRestrictions + dataTrace) |
| Sprint 3 (Week 3-4) | Network hardening | NW-H7, NW-H12, NW-M1, NW-M10 (NAT HA + SG tightening + NACLs + free endpoints) |
| Sprint 4 (Week 4-6) | WAF tuning (data-driven) | NW-H8, NW-H10, NW-M8, NW-M9, NW-M13 (geo-restriction + rule groups + AI rate limits — after 30 days of log data) |
| Sprint 5+ | Ongoing | Remaining Medium + Low findings as capacity permits |

---

*This review document consolidates findings from infrastructure code analysis across `cdk/lib/vpc-stack.ts`, `cdk/lib/database-stack.ts`, `cdk/lib/api-stack.ts`, `cdk/lib/waf-stack.ts`, `cdk/lambda/` handlers, and 10 existing code review documents. Cross-references: [`REMEDIATION-STATUS.md`](REMEDIATION-STATUS.md), [`code-review-cdk-infrastructure.md`](code-review-cdk-infrastructure.md), [`code-review-security.md`](code-review-security.md), [`code-review-rds.md`](code-review-rds.md), [`code-review-well-architected.md`](code-review-well-architected.md)*
