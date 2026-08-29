# Returns Desk MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a Session-isolated, Agent-ready returns desk where WebMCP can inspect return facts and submit pending RMA proposals, while only explicit human UI actions can approve and atomically simulate completion.

**Architecture:** A TypeScript full-stack Worker serves a React SPA and `/api/v1`. HTTP routes and WebMCP tools are thin adapters over shared domain services; D1 repositories enforce Session scope, constraints, idempotency, and atomic approval batches. WebMCP is a progressive enhancement: it registers six static tools when `document.modelContext` exists and synchronizes UI by re-fetching versioned Case aggregates.

**Tech Stack:** Node.js 22+, npm, TypeScript strict mode, React, Vite, Cloudflare Vite plugin, Cloudflare Workers, Hono, Zod, Cloudflare D1/native SQL, TanStack Query, React Router, Vitest with Cloudflare Workers integration, Testing Library, Playwright.

**Spec:** `项目设计/完整规格.md` and `项目设计/API与WebMCP详细契约.md`

## Global Constraints

- Treat every order, refund, credit, inventory change, label, and tracking number as Demo data; no real payment, commerce, email, or logistics integration.
- Use `document.modelContext` only after feature detection; the complete human UI must work when WebMCP is absent.
- Register exactly six WebMCP tools. Never register eligibility review, approve, reject, replace, Reset, or policy-write capabilities.
- Use integer cents for money and RFC 3339 UTC strings for time. Inject `Clock` and `IdGenerator` into deterministic domain code.
- Every repository query and mutation includes `session_id`; cross-Session and missing entities share the same 404 response.
- Use HttpOnly, Secure, SameSite=Lax Session cookies. All writes validate CSRF, Origin, `expectedSeedVersion`, and capability.
- Use D1 prepared statements and `D1Database.batch()` for atomic batches. Do not use an ORM or assume interactive `BEGIN/COMMIT` support.
- `check_return_eligibility` and `submit_rma_for_approval` have `readOnlyHint: false`; the other four tools have `readOnlyHint: true`.
- Execution cancellation is best effort. Idempotency, conditional updates, constraints, and transaction rollback—not AbortSignal propagation—guarantee correctness.
- TypeScript uses `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Request schemas reject unknown fields.
- Run the smallest targeted test red/green for each change, then `npm run check` before each task commit.
- Do not import anything from `spikes/webmcp/`; that directory remains throwaway evidence.
- The workspace currently has no Git repository. Execute Task 1 Step 1 in place; create an isolated worktree only after the baseline commit exists.

## Locked File Structure

```text
.
├── src/
│   ├── app/                    # Router, providers, query client, shell
│   ├── components/             # Reusable accessible UI controls
│   ├── pages/                  # Dashboard, Orders, Case, Queue, Policies
│   ├── api/                    # Browser HTTP client and error decoding
│   ├── webmcp/                 # Types, definitions, registry, Case sync
│   └── shared/contracts/       # API/tool schemas and transport-neutral types
├── worker/
│   ├── http/                   # Hono middleware, envelopes, error mapping
│   ├── routes/                 # `/api/v1` route modules
│   ├── domain/                 # Policy, eligibility, proposal, approval services
│   ├── repositories/           # Session-scoped D1 access
│   ├── demo/                   # Seed and Reset logic
│   └── index.ts                # Worker entry point
├── migrations/                 # Ordered D1 SQL migrations
├── test/
│   ├── unit/                   # Pure policy/state logic
│   ├── integration/            # D1 repositories and transactions
│   ├── contract/               # HTTP and WebMCP schemas
│   ├── ui/                     # React components and pages
│   └── fixtures/               # Fixed clock, IDs, domain fixtures
├── e2e/                        # Playwright user, security, and Demo flows
├── scripts/                    # Release, smoke, and headed WebMCP checks
└── docs/                       # Demo, deployment, evaluation, submission docs
```

---

### Task 1: Scaffold the Cloudflare React Worker and Quality Gate

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `wrangler.jsonc`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `worker/index.ts`
- Create: `worker/env.ts`
- Create: `test/unit/smoke.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Consumes: none.
- Produces: `Env { DB: D1Database; ASSETS: Fetcher; APP_ENV: string }`, a Worker fetch entry point, the React mount point, and the standard commands used by every later task.

- [ ] **Step 1: Initialize Git and preserve the approved design baseline**

Run:

```bash
git init
git add 项目设计 docs/superpowers/plans spikes/webmcp
git commit -m "docs: establish returns desk specification"
```

Expected: the first commit contains only approved design documents, the final plan, and the explicitly throwaway Spike harness. After this commit, the execution driver may use `superpowers:using-git-worktrees` before Task 2.

- [ ] **Step 2: Initialize npm and install the locked dependency set**

Run:

```bash
npm init -y
npm install react react-dom react-router @tanstack/react-query hono zod
npm install -D typescript vite @vitejs/plugin-react @cloudflare/vite-plugin @cloudflare/vitest-plugin wrangler vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom @playwright/test eslint @eslint/js typescript-eslint
```

Expected: `package-lock.json` records resolved versions and `npm audit` reports no unreviewed critical vulnerability.

- [ ] **Step 3: Add a failing runtime smoke test**

Create `test/unit/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import worker from "../../worker/index";

describe("worker", () => {
  it("returns the API health envelope", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/v1/health"), {} as never, {} as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { status: "ok" } });
  });
});
```

- [ ] **Step 4: Run the test and verify the missing entry point failure**

Run: `npx vitest run test/unit/smoke.test.ts`

Expected: FAIL because `worker/index.ts` does not exist.

- [ ] **Step 5: Add strict configuration and minimal Worker/UI entry points**

Set scripts in `package.json`:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test && npm run build",
    "deploy": "wrangler deploy"
  }
}
```

Create `worker/env.ts` and `worker/index.ts`:

```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ENV: "development" | "test" | "production";
  CHANNEL_SIGNING_KEY: string;
}
```

```ts
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/health") {
      return Response.json({ data: { status: "ok" } });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
```

Configure `wrangler.jsonc` for local development as follows; Task 14 records the provisioned remote D1 ID in the production environment:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "returns-desk",
  "main": "worker/index.ts",
  "compatibility_date": "2026-08-29",
  "vars": { "APP_ENV": "development" },
  "d1_databases": [{ "binding": "DB", "database_name": "returns-desk", "database_id": "local" }],
  "assets": {
    "binding": "ASSETS",
    "directory": "./dist/client",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  }
}
```

Configure `vite.config.ts` with `react()` and `cloudflare()`.

- [ ] **Step 6: Prove the scaffold passes and commit**

Run:

```bash
npx vitest run test/unit/smoke.test.ts
npm run typecheck
npm run build
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts wrangler.jsonc index.html src worker test .gitignore
git commit -m "chore: scaffold returns desk worker"
```

Expected: all commands exit 0; build emits Worker and SPA assets.

---

### Task 2: Define Shared Contracts, Errors, and Deterministic Primitives

**Files:**
- Create: `src/shared/contracts/common.ts`
- Create: `src/shared/contracts/eligibility.ts`
- Create: `src/shared/contracts/rma.ts`
- Create: `src/shared/contracts/tools.ts`
- Create: `src/shared/contracts/api.ts`
- Create: `worker/domain/primitives.ts`
- Create: `worker/domain/errors.ts`
- Create: `test/contract/schemas.test.ts`
- Create: `test/fixtures/runtime.ts`

**Interfaces:**
- Consumes: Zod.
- Produces: `DomainError`, `Clock`, `IdGenerator`, `ToolName`, six input schemas, `SuccessEnvelope<T>`, `ErrorEnvelope`, `EffectRef`, and shared enums used by every API/UI/domain module.

- [ ] **Step 1: Write failing schema and error tests**

Create `test/contract/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkEligibilityInput, submitProposalInput, toolNames } from "../../src/shared/contracts/tools";

describe("tool contracts", () => {
  it("contains exactly the six approved tools", () => {
    expect(toolNames).toEqual([
      "search_orders", "get_return_policy", "check_return_eligibility",
      "compare_resolution_options", "draft_customer_message", "submit_rma_for_approval",
    ]);
  });

  it("rejects unknown fields and zero quantity", () => {
    expect(() => checkEligibilityInput.parse({
      orderId: "ord_1", orderItemId: "item_1", requestedQuantity: 0,
      reasonCode: "wrong_size", conditionCode: "opened_unused",
      idempotencyKey: "eligibility-1", unexpected: true,
    })).toThrow();
  });

  it("requires a proposal idempotency key", () => {
    expect(submitProposalInput.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the contract test red**

Run: `npx vitest run test/contract/schemas.test.ts`

Expected: FAIL because shared schemas do not exist.

- [ ] **Step 3: Implement exact shared types and strict Zod schemas**

Use these stable interfaces in `common.ts` and `errors.ts`:

```ts
export type EffectRef = {
  entityType: string;
  entityId: string;
  entityVersion: number;
  caseId?: string;
};

export type SuccessEnvelope<T> = {
  data: T;
  meta: { requestId: string; serverTime: string; seedVersion: number };
  effects?: EffectRef[];
};

export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly recoveryAction?: string,
    readonly currentState?: string,
  ) { super(code); }
}
```

Export `reasonCode`, `conditionCode`, `resolutionType`, `eligibilityStatus`, and `proposalStatus` Zod enums. Implement all six schemas verbatim from `项目设计/API与WebMCP详细契约.md` with `.strict()`. Export `toolNames` as the literal array tested above.

- [ ] **Step 4: Add deterministic test primitives**

Create `worker/domain/primitives.ts`:

```ts
export interface Clock { now(): Date }
export interface IdGenerator { next(prefix: string): string }
export const systemClock: Clock = { now: () => new Date() };
export const cryptoIds: IdGenerator = {
  next: prefix => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
};
```

Create fixed implementations in `test/fixtures/runtime.ts` returning `2026-08-29T07:00:00Z` and deterministic sequential IDs.

- [ ] **Step 5: Run all schema checks and commit**

Run:

```bash
npx vitest run test/contract/schemas.test.ts
npm run typecheck
git add src/shared worker/domain test/contract test/fixtures
git commit -m "feat: define shared return contracts"
```

Expected: contract tests pass and no `any` is introduced.

---

### Task 3: Create D1 Schema, Constraints, Seed, and Session Lifecycle

**Files:**
- Create: `migrations/0001_initial.sql`
- Create: `migrations/0002_approval_guards.sql`
- Create: `worker/repositories/session-repository.ts`
- Create: `worker/repositories/audit-repository.ts`
- Create: `worker/repositories/idempotency-repository.ts`
- Create: `worker/demo/seed.ts`
- Create: `worker/demo/reset-service.ts`
- Create: `test/integration/setup.ts`
- Create: `test/integration/schema.test.ts`
- Create: `test/integration/session-reset.test.ts`

**Interfaces:**
- Consumes: `Clock`, `IdGenerator`, `Env.DB`.
- Produces: all tables/constraints from the data model, `SessionRepository.getOrCreate(cookieId)`, `seedDemoSession(db, sessionId)`, and `ResetService.reset(command)`.

- [ ] **Step 1: Write failing migration invariant tests**

Create `test/integration/schema.test.ts` asserting:

```ts
it("rejects two pending proposals for one Case", async () => {
  await seedCase(db, "case_1");
  await insertPending(db, "prop_1", "case_1");
  await expect(insertPending(db, "prop_2", "case_1")).rejects.toThrow();
});

it("rejects a second RMA for one proposal", async () => {
  await insertApprovedFixture(db);
  await expect(insertRma(db, "rma_2", "prop_1")).rejects.toThrow();
});
```

Use `@cloudflare/vitest-plugin` setup with `readD1Migrations()` and `applyD1Migrations()`.

- [ ] **Step 2: Run migration tests red**

Run: `npx vitest run test/integration/schema.test.ts`

Expected: FAIL because migrations/tables are absent.

- [ ] **Step 3: Implement the complete initial migration**

Create every table in `项目设计/数据模型.md`, including `inventory_version`, mutable aggregate `version`, foreign keys, nonnegative CHECK constraints, an `idempotency_records` table keyed by Session + command kind + key with request hash/result reference, and a `rate_limit_buckets` table keyed by bucket kind plus one-way Session/IP digest. Add these indexes:

```sql
CREATE UNIQUE INDEX ux_orders_session_number ON orders(session_id, order_number);
CREATE UNIQUE INDEX ux_one_pending_proposal_per_case
  ON rma_proposals(case_id) WHERE status = 'pending';
CREATE UNIQUE INDEX ux_rma_proposal ON rmas(proposal_id);
CREATE UNIQUE INDEX ux_rma_number ON rmas(session_id, rma_number);
CREATE UNIQUE INDEX ux_inventory_reservation_rma ON inventory_reservations(rma_id);
CREATE UNIQUE INDEX ux_return_label_rma ON return_labels(rma_id);
CREATE UNIQUE INDEX ux_refund_rma ON simulated_refunds(rma_id);
CREATE UNIQUE INDEX ux_store_credit_rma ON store_credits(rma_id);
```

Add a trigger rejecting proposal transitions unless `OLD.status = 'pending'`, except an idempotent no-op to the same terminal value.

- [ ] **Step 4: Add Session seed and Reset red/green tests**

Test that two Session IDs receive distinct seeded rows, Reset increments `seed_version`, removes only the target Session's business rows, reseeds deterministic Demo scenarios, and leaves Session B untouched. Implement `ResetService.reset({ sessionId, expectedSeedVersion, idempotencyKey })` as one D1 batch ending with `demo.reset` audit.

```ts
await db.batch([
  deleteSessionEffects.bind(sessionId),
  deleteSessionCases.bind(sessionId),
  incrementSeedVersion.bind(sessionId, expectedSeedVersion),
  ...buildSeedStatements(sessionId, nextSeedVersion),
  insertAudit.bind(sessionId, "demo.reset"),
]);
```

- [ ] **Step 5: Verify migrations from an empty database and commit**

Run:

```bash
npx wrangler d1 migrations apply returns-desk --local
npx vitest run test/integration/schema.test.ts test/integration/session-reset.test.ts
git add migrations worker/repositories/session-repository.ts worker/demo test/integration
git commit -m "feat: add d1 schema and demo sessions"
```

Expected: empty-database migration succeeds; isolation and Reset tests pass.

---

### Task 4: Implement Security Middleware and HTTP Envelopes

**Files:**
- Create: `worker/http/context.ts`
- Create: `worker/http/session.ts`
- Create: `worker/http/channel-token.ts`
- Create: `worker/http/csrf.ts`
- Create: `worker/http/capability.ts`
- Create: `worker/http/envelope.ts`
- Create: `worker/http/error-mapper.ts`
- Create: `worker/http/security-headers.ts`
- Create: `worker/app.ts`
- Modify: `worker/index.ts`
- Create: `test/contract/security-middleware.test.ts`
- Create: `test/contract/error-envelope.test.ts`

**Interfaces:**
- Consumes: `SessionRepository`, `DomainError`, shared envelopes.
- Produces: `RequestContext { sessionId, seedVersion, csrfToken, actor, requestId }`, signed human/agent channel tokens, `requireCapability(name)`, `requireCsrf()`, and `createApp(deps)` used by all routes.

- [ ] **Step 1: Write failing CSRF, Origin, IDOR-shaping, and header tests**

```ts
it.each([
  ["missing csrf", {}],
  ["cross origin", { "x-csrf-token": token, origin: "https://evil.test" }],
])("rejects %s", async (_name, headers) => {
  const response = await app.request("/api/v1/test-write", { method: "POST", headers });
  expect(response.status).toBe(403);
});

it("sets CSP and secure cookie attributes", async () => {
  const response = await app.request("/api/v1/session/bootstrap");
  expect(response.headers.get("content-security-policy")).toContain("object-src 'none'");
  expect(response.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
});

it("does not let an agent channel token call a human route", async () => {
  const response = await callHumanApproval({ channelToken: agentToken, csrfToken: token });
  expect(response.status).toBe(403);
});
```

- [ ] **Step 2: Run middleware tests red**

Run: `npx vitest run test/contract/security-middleware.test.ts test/contract/error-envelope.test.ts`

Expected: FAIL because `createApp` and middleware are missing.

- [ ] **Step 3: Implement request context and capability guards**

Define explicit capability constants. At bootstrap, issue separate short-lived HMAC-signed `human` and `agent` channel tokens bound to Session ID, seedVersion, expiry, and allowed capability class. The UI HTTP client retains only the human token; the WebMCP adapter closure receives only the agent token. Map each route to one constant at registration time and derive actor from the verified token:

```ts
export type Actor = { type: "agent" | "human" | "system"; id: string };

export function requireCapability(required: Capability) {
  return createMiddleware(async (c, next) => {
    if (!c.get("capabilities").has(required)) throw new DomainError("FORBIDDEN", 403, false);
    await next();
  });
}
```

Never accept `actorType` or `sessionId` from request JSON/query.

- [ ] **Step 4: Implement stable envelopes and security headers**

Map `DomainError` to the exact error shape in the detailed contract. Unknown errors return `INTERNAL_ERROR`, correlationId, status 500, and no exception text. Add CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, and frame policy. Add per-route body size and string limits before domain calls.

```ts
export function mapError(error: unknown, correlationId: string): Response {
  if (error instanceof DomainError) {
    return Response.json({ error: {
      code: error.code, message: safeMessage(error.code), retryable: error.retryable,
      correlationId, recoveryAction: error.recoveryAction, currentState: error.currentState,
    } }, { status: error.httpStatus });
  }
  return Response.json({ error: {
    code: "INTERNAL_ERROR", message: "The request could not be completed.",
    retryable: false, correlationId,
  } }, { status: 500 });
}
```

- [ ] **Step 5: Prove security contracts and commit**

Run:

```bash
npx vitest run test/contract/security-middleware.test.ts test/contract/error-envelope.test.ts
npm run typecheck
git add worker/http worker/app.ts worker/index.ts test/contract
git commit -m "feat: enforce session and request security"
```

Expected: tests prove CSRF/Origin/capability failures and safe envelopes.

---

### Task 5: Implement the Deterministic Policy and Eligibility Engine

**Files:**
- Create: `worker/domain/policy/types.ts`
- Create: `worker/domain/policy/rule-catalog.ts`
- Create: `worker/domain/policy/evaluate.ts`
- Create: `worker/domain/policy/resolutions.ts`
- Create: `worker/domain/policy/hash-input.ts`
- Create: `worker/domain/eligibility-service.ts`
- Create: `worker/repositories/order-repository.ts`
- Create: `worker/repositories/policy-repository.ts`
- Create: `worker/repositories/case-repository.ts`
- Create: `worker/repositories/eligibility-repository.ts`
- Create: `test/unit/policy-engine.test.ts`
- Create: `test/unit/policy-matrix.test.ts`
- Create: `test/integration/eligibility-service.test.ts`

**Interfaces:**
- Consumes: shared enums, `Clock`, repositories.
- Produces: `evaluateEligibility(input, policy): EligibilityDecision`, `EligibilityService.check(command, context)`, and immutable eligibility snapshots.

- [ ] **Step 1: Write table-driven failing policy tests**

Cover boundary time, undelivered, zero/excess quantity, Final Sale normal reasons, damage exception, condition conflicts, priority override, same-priority conflict, inventory zero, consent, rounding, and `returnRequired`:

```ts
it.each([
  ["window boundary", fixture({ now: windowEndMinus1 }), "eligible"],
  ["window closed", fixture({ now: windowEnd }), "ineligible"],
  ["final sale damaged", fixture({ finalSale: true, reasonCode: "damaged" }), "needs_review"],
])("%s", (_name, input, status) => {
  expect(evaluateEligibility(input, policy).status).toBe(status);
});
```

- [ ] **Step 2: Run the matrix red**

Run: `npx vitest run test/unit/policy-engine.test.ts test/unit/policy-matrix.test.ts`

Expected: FAIL because `evaluateEligibility` is missing.

- [ ] **Step 3: Implement the five-layer policy algorithm**

Sort by fixed layer, descending priority, ascending rule ID. Return `POLICY_RULE_CONFLICT` for same-priority conflicting terminal/field outcomes. Generate at least one allowed resolution for eligible; remove only exchange when inventory is unavailable. Compute `inputHash` from canonical JSON containing every fact listed in the policy spec.

```ts
const ordered = rules.toSorted((a, b) =>
  a.layer - b.layer || b.priority - a.priority || a.id.localeCompare(b.id));
const conflict = findSamePriorityFieldConflict(ordered);
if (conflict) return needsReview("POLICY_RULE_CONFLICT", conflict);
return finalizeDecision(applyRules(baseDecision(input), ordered));
```

- [ ] **Step 4: Write and pass service persistence tests**

Test that checking eligibility creates/updates the Case, stores an immutable snapshot, increments Case version, deduplicates identical idempotency keys, rejects a reused key with a different hash, and returns `needs_review` without enabling proposal submission. Implement repositories with `session_id` in every SQL predicate.

```ts
export interface EligibilityService {
  check(command: CheckEligibilityCommand, context: CommandContext): Promise<EligibilityResult>;
}

const row = await db.prepare(
  `SELECT ec.* FROM eligibility_checks ec
   JOIN return_cases rc ON rc.id = ec.case_id
   WHERE ec.id = ? AND rc.session_id = ?`
).bind(checkId, context.sessionId).first();
```

- [ ] **Step 5: Run policy/eligibility suites and commit**

Run:

```bash
npx vitest run test/unit/policy-engine.test.ts test/unit/policy-matrix.test.ts test/integration/eligibility-service.test.ts
git add worker/domain/policy worker/domain/eligibility-service.ts worker/repositories test/unit test/integration/eligibility-service.test.ts
git commit -m "feat: implement deterministic eligibility"
```

Expected: the complete policy matrix and immutable persistence tests pass.

---

### Task 6: Implement Read Services, Resolution Comparison, and Message Drafting

**Files:**
- Create: `worker/domain/order-service.ts`
- Create: `worker/domain/commerce-adapter.ts`
- Create: `worker/demo/demo-commerce-adapter.ts`
- Create: `worker/domain/policy-read-service.ts`
- Create: `worker/domain/policy-admin-service.ts`
- Create: `worker/domain/resolution-service.ts`
- Create: `worker/domain/message-service.ts`
- Create: `worker/domain/case-query-service.ts`
- Create: `worker/domain/dashboard-service.ts`
- Create: `worker/domain/approval-queue-service.ts`
- Create: `worker/domain/templates/en-US.ts`
- Create: `worker/domain/templates/zh-CN.ts`
- Create: `test/unit/resolution-service.test.ts`
- Create: `test/unit/message-service.test.ts`
- Create: `test/integration/order-search.test.ts`
- Create: `test/integration/policy-admin.test.ts`
- Create: `test/integration/workspace-queries.test.ts`

**Interfaces:**
- Consumes: order/policy/eligibility repositories.
- Produces: `CommerceAdapter`, `DemoCommerceAdapter`, `OrderService.search`, `PolicyReadService.getLockedPolicy`, `PolicyAdminService`, `ResolutionService.compare`, `MessageService.draft`, and query services for Dashboard, Case Workspace, Approval Queue, and Activity.

- [ ] **Step 1: Write failing behavior tests**

Assert search caps at five and masks email, multiple results set `requiresSelection`, locked policy is used instead of active policy, comparison never adds a solution, missing facts produce `missingInformation` with no invented message, Case queries return a monotonically increasing version, and approval queues expose only pending/reviewable rows.

```ts
expect(await messages.draft(missingFacts)).toEqual({
  subject: "", bodyText: "", factsUsed: [],
  missingInformation: ["CUSTOMER_NAME"], sendStatus: "not_sent",
});
```

- [ ] **Step 2: Run targeted tests red**

Run: `npx vitest run test/unit/resolution-service.test.ts test/unit/message-service.test.ts test/integration/order-search.test.ts test/integration/policy-admin.test.ts test/integration/workspace-queries.test.ts`

Expected: FAIL because services are absent.

- [ ] **Step 3: Implement safe reads and deterministic ranking**

Define `CommerceAdapter` with `searchOrders`, `getOrder`, and `getVariantInventory`; implement `DemoCommerceAdapter` over Session-scoped repositories. Use server-calculated `merchantCostCents`; rank by the requested preference with stable resolution-type tie breaking. Return only masked customer data in search results. Keep customer names, titles, and notes out of policy explanations.

```ts
export interface CommerceAdapter {
  searchOrders(sessionId: string, query: string, limit: number): Promise<OrderSummary[]>;
  getOrder(sessionId: string, orderId: string): Promise<OrderDetails>;
  getVariantInventory(sessionId: string, variantId: string): Promise<InventoryFact>;
}
```

- [ ] **Step 4: Implement controlled templates, workspace queries, and policy administration**

Templates interpolate only a typed fact map. Do not accept arbitrary HTML and always set `sendStatus: "not_sent"`. Do not persist drafts; write only a minimal `message.drafted` audit summary. Workspace query services return safe aggregates and cursor pages without policy calculations. `PolicyAdminService` only mutates draft versions, validates the supported rule catalog and conflicts, then activates the draft and retires the former active version in one D1 batch.

```ts
export interface PolicyAdminService {
  updateDraft(command: UpdatePolicyDraft, context: HumanContext): Promise<PolicyVersion>;
  validateDraft(id: string, context: HumanContext): Promise<PolicyValidation>;
  activate(command: ActivatePolicy, context: HumanContext): Promise<PolicyVersion>;
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run test/unit/resolution-service.test.ts test/unit/message-service.test.ts test/integration/order-search.test.ts test/integration/policy-admin.test.ts test/integration/workspace-queries.test.ts
git add worker/domain worker/repositories test/unit test/integration/order-search.test.ts
git commit -m "feat: add return read and drafting services"
```

---

### Task 7: Implement Proposal State Machine, Idempotency, Lazy Expiry, and Human Review

**Files:**
- Create: `worker/domain/proposal-service.ts`
- Create: `worker/domain/eligibility-review-service.ts`
- Create: `worker/repositories/proposal-repository.ts`
- Create: `worker/domain/proposal-transitions.ts`
- Create: `test/unit/proposal-transitions.test.ts`
- Create: `test/integration/proposal-service.test.ts`
- Create: `test/integration/eligibility-review.test.ts`

**Interfaces:**
- Consumes: eligibility, Case, and proposal repositories.
- Produces: `ProposalService.submit/read/reject/replace`, `EligibilityReviewService.review`, terminal transition enforcement, and lazy expiry.

- [ ] **Step 1: Write failing state transition tests**

```ts
it.each(["approved", "rejected", "expired", "superseded", "invalidated"] as const)(
  "does not revive %s", status => expect(() => transition(status, "pending")).toThrow("PROPOSAL_NOT_PENDING"),
);
```

Add integration tests for same-key replay, different-payload reuse, one pending per Case, Agent conflict, exactly one expiry event, explicit human reject, and transactional replace.

- [ ] **Step 2: Run proposal tests red**

Run: `npx vitest run test/unit/proposal-transitions.test.ts test/integration/proposal-service.test.ts`

Expected: FAIL because proposal services are missing.

- [ ] **Step 3: Implement submit and lazy expiry**

Canonicalize the submission payload, hash it, and return the original proposal for same key/hash. `read()` performs `UPDATE ... WHERE status='pending' AND expires_at <= ?`, checks affected rows, and writes `rma_proposal.expired` only for the winning request.

```sql
UPDATE rma_proposals
SET status = 'expired', version = version + 1
WHERE id = ?
  AND case_id IN (SELECT id FROM return_cases WHERE session_id = ?)
  AND status = 'pending' AND expires_at <= ?;
```

```ts
if (expired.meta.changes === 1) await audit.append("rma_proposal.expired", proposalId);
```

- [ ] **Step 4: Implement human review/reject/replace**

Review creates a child eligibility snapshot with `parentCheckId` and human metadata. Replace batches: insert new pending → update old to superseded → link `superseded_by_proposal_id` → write two audit events; any failure rolls back. Agent capability is not accepted by these methods.

```ts
export interface ProposalService {
  submit(command: SubmitProposal, context: CommandContext): Promise<ProposalResult>;
  reject(command: RejectProposal, context: HumanContext): Promise<ProposalResult>;
  replace(command: ReplaceProposal, context: HumanContext): Promise<ProposalResult>;
}
```

- [ ] **Step 5: Verify all state paths and commit**

Run:

```bash
npx vitest run test/unit/proposal-transitions.test.ts test/integration/proposal-service.test.ts test/integration/eligibility-review.test.ts
git add worker/domain worker/repositories/proposal-repository.ts test
git commit -m "feat: add rma proposal workflow"
```

Expected: all six terminal states and idempotency/concurrency cases pass.

---

### Task 8: Implement Atomic Human Approval and Simulated Side Effects

**Files:**
- Modify: `migrations/0002_approval_guards.sql`
- Create: `worker/domain/approval-service.ts`
- Create: `worker/repositories/approval-repository.ts`
- Create: `worker/repositories/approval-batch.ts`
- Create: `test/integration/approval-transaction.test.ts`
- Create: `test/integration/approval-concurrency.test.ts`

**Interfaces:**
- Consumes: pending proposal snapshot and D1 batch API.
- Produces: `ApprovalService.approve(command, humanContext): Promise<ApprovalResult>` returning one completed RMA or a committed invalidated result.

- [ ] **Step 1: Write failing rollback and concurrency tests**

Cover refund, credit, exchange, all three return-label combinations, duplicate approval, two approvals of the last inventory unit, quantity race, stale eligibility, Reset race, and injected failure after each batch statement.

```ts
expect(await Promise.allSettled([approve("prop_a"), approve("prop_b")]))
  .toSatisfy(results => completedCount(results) === 1);
expect(await inventory("var_last")).toBe(0);
expect(await committedReservations("var_last")).toHaveLength(1);
```

- [ ] **Step 2: Run approval tests red**

Run: `npx vitest run test/integration/approval-transaction.test.ts test/integration/approval-concurrency.test.ts`

Expected: FAIL because approval batching is missing.

- [ ] **Step 3: Add database approval guards**

Create a `BEFORE UPDATE OF status` trigger for `status='approved'` that raises `ABORT` unless exactly one completed RMA, one RMA item, the correct solution-specific effect, the exchange committed reservation, and the conditional label are present. The trigger makes the final proposal transition a transaction guard; any missing artifact rolls back the entire D1 batch.

```sql
CREATE TRIGGER guard_proposal_approval
BEFORE UPDATE OF status ON rma_proposals
WHEN NEW.status = 'approved'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM rmas r
    JOIN rma_items ri ON ri.rma_id = r.id
    WHERE r.proposal_id = NEW.id AND r.status = 'completed'
  ) THEN RAISE(ABORT, 'APPROVAL_ARTIFACT_MISSING') END;
END;
```

Extend the trigger with branch-specific EXISTS/NOT EXISTS checks for refund, store credit, exchange committed reservation, and `return_required` label.

- [ ] **Step 4: Implement branch-specific prepared-statement batches**

For exchange, batch in this order: insert unique RMA from valid pending proposal → conditionally increment returned quantity → insert RMA item only when `changes() = 1` → conditionally decrement inventory → insert committed reservation only when `changes() = 1` → optional label → audit rows → update proposal to approved last. Refund and credit use equivalent branch-specific effects. On guard/business failure, run a separate conditional invalidation batch; on D1/technical failure, leave pending and rethrow safe 503.

```ts
const results = await db.batch([
  statements.insertRma,
  statements.incrementReturnedQuantity,
  statements.insertRmaItemAfterQuantityChange,
  statements.decrementInventory,
  statements.insertCommittedReservationAfterInventoryChange,
  ...statements.optionalReturnLabel,
  ...statements.audit,
  statements.approveProposalLast,
]);
return decodeApprovalBatch(results);
```

- [ ] **Step 5: Prove atomicity, then commit**

Run:

```bash
npx vitest run test/integration/approval-transaction.test.ts test/integration/approval-concurrency.test.ts
npm run typecheck
git add migrations/0002_approval_guards.sql worker/domain/approval-service.ts worker/repositories/approval-* test/integration/approval-*
git commit -m "feat: atomically approve simulated rmas"
```

Expected: every fault injection leaves zero partial effects; concurrent approval creates at most one RMA and one inventory commitment.

---

### Task 9: Expose the Complete `/api/v1` HTTP Contract

**Files:**
- Create: `worker/routes/session.ts`
- Create: `worker/routes/dashboard.ts`
- Create: `worker/routes/orders.ts`
- Create: `worker/routes/cases.ts`
- Create: `worker/routes/eligibility.ts`
- Create: `worker/routes/proposals.ts`
- Create: `worker/routes/policies.ts`
- Create: `worker/routes/index.ts`
- Modify: `worker/app.ts`
- Create: `test/contract/api-routes.test.ts`
- Create: `test/contract/api-fixtures.test.ts`

**Interfaces:**
- Consumes: all domain services and security middleware.
- Produces: every route, method, status, envelope, effect, and error code in `项目设计/API与WebMCP详细契约.md`.

- [ ] **Step 1: Write a failing route inventory contract test**

Define the expected method/path/capability table in the test and assert every entry responds with something other than 404 under a valid fixture Session. Separately assert no `/approve`, `/reject`, `/review`, `/replace`, `/reset`, or policy mutation route accepts Agent capability.

- [ ] **Step 2: Run the API contract red**

Run: `npx vitest run test/contract/api-routes.test.ts test/contract/api-fixtures.test.ts`

Expected: FAIL listing unregistered routes.

- [ ] **Step 3: Implement read and safe-compute routes**

Parse path/query/body with the shared Zod schemas, call exactly one service method per handler, and return success envelopes with requestId/serverTime/seedVersion. Add cursor caps and search limit 5.

```ts
routes.post("/eligibility-checks", requireCapability("eligibility.check"), requireCsrf(), async c => {
  const input = checkEligibilityInput.parse(await c.req.json());
  const result = await services.eligibility.check(input, c.get("requestContext"));
  return c.json(successEnvelope(result.data, result.effects, c), result.created ? 201 : 200);
});
```

- [ ] **Step 4: Implement write and human-only routes**

Lift `Idempotency-Key`, expected versions, Session, CSRF, and actor into command context. Map pending conflicts to 409, invalid domain inputs to 422, and deterministic eligibility outcomes to 200/201 rather than exceptions. Never expose SQL/stack details.

```ts
const commandContext = {
  ...c.get("requestContext"),
  idempotencyKey: requireHeader(c, "Idempotency-Key"),
  expectedSeedVersion: body.expectedSeedVersion,
};
```

- [ ] **Step 5: Snapshot all fixtures and commit**

Run:

```bash
npx vitest run test/contract/api-routes.test.ts test/contract/api-fixtures.test.ts
npm run check
git add worker/routes worker/app.ts test/contract
git commit -m "feat: expose returns desk api"
```

Expected: documented valid/error fixtures match exact response schemas.

---

### Task 10: Build the React Information Architecture and Case Workspace

**Files:**
- Create: `src/app/providers.tsx`
- Create: `src/app/router.tsx`
- Create: `src/app/query-client.ts`
- Create: `src/api/client.ts`
- Create: `src/api/errors.ts`
- Create: `src/components/AppShell.tsx`
- Create: `src/components/AsyncRegion.tsx`
- Create: `src/components/ConfirmDialog.tsx`
- Create: `src/components/UntrustedText.tsx`
- Create: `src/pages/DashboardPage.tsx`
- Create: `src/pages/OrdersPage.tsx`
- Create: `src/pages/CasePage.tsx`
- Create: `src/pages/ApprovalQueuePage.tsx`
- Create: `src/pages/PoliciesPage.tsx`
- Create: `src/styles.css`
- Create: `test/ui/navigation.test.tsx`
- Create: `test/ui/case-page.test.tsx`

**Interfaces:**
- Consumes: `/api/v1` browser client.
- Produces: five accessible routes, versioned Case query keys, standard idle/loading/ready/empty/error/stale regions, and explicit human action entry points.

- [ ] **Step 1: Write failing navigation and Case state tests**

Assert global links, keyboard navigation, multiple-order selection, needs_review hides submit, non-pending hides approve, untrusted text never renders as HTML, and stale version disables commands.

```tsx
render(<UntrustedText value={'<img src=x onerror="alert(1)">'} />);
expect(screen.getByText(/<img/)).toBeVisible();
expect(document.querySelector("img")).toBeNull();
```

- [ ] **Step 2: Run UI tests red**

Run: `npx vitest run --environment jsdom test/ui/navigation.test.tsx test/ui/case-page.test.tsx`

Expected: FAIL because pages/components do not exist.

- [ ] **Step 3: Implement app shell, router, HTTP client, and async regions**

Use React Router paths `/`, `/orders`, `/cases/:caseId`, `/approvals`, `/policies`. The UI HTTP client decodes `ErrorEnvelope` into `ApiError`, keeps the bootstrap-issued human channel token in a provider closure, and always uses `credentials: "same-origin"`. TanStack Query keys include entity ID but not Session cookie or channel token.

```ts
export async function apiRequest<T>(path: string, init: RequestInit, auth: UiAuth): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-CSRF-Token", auth.csrfToken);
  headers.set("X-Channel-Token", auth.humanToken);
  const response = await fetch(`/api/v1${path}`, {
    ...init, headers, credentials: "same-origin",
  });
  return decodeEnvelope<T>(response);
}
```

- [ ] **Step 4: Implement Case Workspace and read-only pages**

Render the five Case regions from the page spec, pure-text rule evidence, Activity timeline, Demo badges, version, and recovery actions. Use focus-managed dialogs and live regions. No component calculates policy, money, or status transitions.

```tsx
export function CasePage() {
  const { caseId = "" } = useParams();
  const query = useQuery({ queryKey: ["case", caseId], queryFn: () => cases.get(caseId) });
  return <AsyncRegion query={query}>{data => <CaseWorkspace model={data} />}</AsyncRegion>;
}
```

- [ ] **Step 5: Run UI/accessibility checks and commit**

Run:

```bash
npx vitest run --environment jsdom test/ui/navigation.test.tsx test/ui/case-page.test.tsx
npm run typecheck
git add src/app src/api src/components src/pages src/styles.css test/ui
git commit -m "feat: build returns desk workspace"
```

---

### Task 11: Add Human Review, Approval, Policy, and Reset Interactions

**Files:**
- Create: `src/components/EligibilityReviewDialog.tsx`
- Create: `src/components/ProposalApprovalDialog.tsx`
- Create: `src/components/ProposalRejectDialog.tsx`
- Create: `src/components/ProposalReplaceDialog.tsx`
- Create: `src/components/ResetDemoDialog.tsx`
- Create: `src/components/PolicyEditor.tsx`
- Modify: `src/pages/CasePage.tsx`
- Modify: `src/pages/PoliciesPage.tsx`
- Modify: `src/components/AppShell.tsx`
- Create: `test/ui/human-actions.test.tsx`
- Create: `test/ui/policy-editor.test.tsx`

**Interfaces:**
- Consumes: human-only HTTP routes, `expectedVersion`, `expectedSeedVersion`.
- Produces: explicit confirmation workflows with idempotency keys and cache invalidation.

- [ ] **Step 1: Write failing confirmation tests**

Assert exact confirmation phrases, structured reason requirements, replacement diff, approval side-effect summary, no bulk approval, Reset second confirmation, focus return, and stale 409 recovery.

- [ ] **Step 2: Run human action tests red**

Run: `npx vitest run --environment jsdom test/ui/human-actions.test.tsx test/ui/policy-editor.test.tsx`

Expected: FAIL because dialogs are missing.

- [ ] **Step 3: Implement human-only mutations**

Generate one idempotency key when each dialog opens and reuse it across network retries. Send the exact confirmation enum from the contract. On 409, preserve form input, close unsafe submit state, refresh the Case, and show the structured recovery action.

```ts
const idempotencyKey = useRef(crypto.randomUUID());
const approve = useMutation({
  mutationFn: () => proposals.approve(proposalId, {
    confirmation: "approve_and_simulate_completion", expectedVersion, expectedSeedVersion,
  }, idempotencyKey.current),
  onError: error => error.code === "ENTITY_VERSION_CONFLICT" && refreshCase(),
});
```

- [ ] **Step 4: Implement draft-only policy editing and Reset**

Policy editor permits only catalog rules and draft versions, shows validation/conflict results before activation, and never mutates active/retired versions. Reset clears the query client and navigates to `/` only after the server returns the new seedVersion/CSRF.

```ts
if (policy.status !== "draft") throw new Error("POLICY_VERSION_IMMUTABLE");
const validation = await policies.validate(policy.id);
if (!validation.valid) return setValidation(validation);
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run --environment jsdom test/ui/human-actions.test.tsx test/ui/policy-editor.test.tsx
git add src/components src/pages test/ui
git commit -m "feat: add explicit human controls"
```

---

### Task 12: Register WebMCP Tools and Synchronize UI by Entity Version

**Files:**
- Create: `src/webmcp/global.d.ts`
- Create: `src/webmcp/tool-definitions.ts`
- Create: `src/webmcp/registry.ts`
- Create: `src/webmcp/sync-effects.ts`
- Create: `src/webmcp/useReturnsDeskTools.ts`
- Modify: `src/app/providers.tsx`
- Create: `test/contract/webmcp-registry.test.ts`
- Create: `test/contract/webmcp-sync.test.ts`
- Create: `scripts/webmcp-headed-smoke.mjs`

**Interfaces:**
- Consumes: shared tool schemas, browser HTTP client, TanStack Query client.
- Produces: `registerReturnsDeskTools(deps): () => void`, exact annotations, best-effort signal forwarding, and `syncEffects(effects): Promise<UiSync>`.

- [ ] **Step 1: Write failing registry and sync tests**

Use a fake `ModelContext` that records definitions/controllers. Assert exactly six names, no human names, annotation matrix, strict schemas, cleanup abort, duplicate-mount safety, API-result compression, and re-fetch until `case.version >= entityVersion`.

```ts
expect(definitions.map(x => [x.name, x.annotations.readOnlyHint])).toEqual([
  ["search_orders", true], ["get_return_policy", true],
  ["check_return_eligibility", false], ["compare_resolution_options", true],
  ["draft_customer_message", true], ["submit_rma_for_approval", false],
]);
```

- [ ] **Step 2: Run WebMCP contracts red**

Run: `npx vitest run test/contract/webmcp-registry.test.ts test/contract/webmcp-sync.test.ts`

Expected: FAIL because registry modules are absent.

- [ ] **Step 3: Implement static definitions and lifecycle**

Feature-detect `document.modelContext?.registerTool`. Create one registration controller per mount. Await or collect registration Promises; log safe compatibility diagnostics without breaking UI. Cleanup aborts the same controller. Do not use `navigator.modelContext`, `provideContext`, `clearContext`, or name-based unregister.

```ts
export function registerReturnsDeskTools(deps: RegistryDeps): () => void {
  const context = document.modelContext;
  if (!context?.registerTool) return () => undefined;
  const controller = new AbortController();
  void Promise.all(toolDefinitions.map(tool =>
    context.registerTool(toBrowserTool(tool, deps), { signal: controller.signal })
  )).catch(error => deps.diagnostics.registrationFailed(error));
  return () => controller.abort();
}
```

- [ ] **Step 4: Implement execution and version synchronization**

Each execute validates input, promotes `idempotencyKey` to the header for writes, uses only the bootstrap-issued agent channel token, injects current seedVersion/CSRF via the HTTP client, forwards `options.signal`, then invalidates/refetches effects. If refresh fails after HTTP success, return business success with `uiSync: "refresh_required"`; never re-run the write merely to refresh UI.

```ts
const result = await deps.agentClient.call(tool.route, parsedInput, { signal: options.signal });
const uiSync = await syncEffects(result.effects).catch(() => "refresh_required" as const);
return { ...compact(result.data), uiSync };
```

- [ ] **Step 5: Run unit contracts and the headed smoke gate, then commit**

Run:

```bash
npx vitest run test/contract/webmcp-registry.test.ts test/contract/webmcp-sync.test.ts
node scripts/webmcp-headed-smoke.mjs
git add src/webmcp src/app/providers.tsx test/contract scripts/webmcp-headed-smoke.mjs
git commit -m "feat: expose safe webmcp tools"
```

Expected: unit contracts pass; headed Chrome discovers six tools, annotations, cleanup, toolchange, and Case version synchronization. Record callback-signal propagation as diagnostic, not a release failure.

---

### Task 13: Add Security Regression Tests, Agent Eval, and End-to-End Flows

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/normal-refund.spec.ts`
- Create: `e2e/exchange.spec.ts`
- Create: `e2e/needs-review.spec.ts`
- Create: `e2e/proposal-terminal-states.spec.ts`
- Create: `e2e/session-security.spec.ts`
- Create: `e2e/reset-and-retry.spec.ts`
- Create: `e2e/accessibility.spec.ts`
- Create: `test/security/idor.test.ts`
- Create: `test/security/prompt-injection.test.ts`
- Create: `test/security/log-privacy.test.ts`
- Create: `worker/http/rate-limit.ts`
- Create: `worker/http/safe-logger.ts`
- Create: `test/eval/agent-cases.json`
- Create: `test/eval/traces/ci.jsonl`
- Create: `scripts/export-agent-trace.mjs`
- Create: `scripts/run-agent-eval.mjs`

**Interfaces:**
- Consumes: deployed/local Worker, seed fixtures, six WebMCP tools.
- Produces: automated evidence for every security and Demo acceptance criterion.

- [ ] **Step 1: Write failing high-risk security tests**

Test Session A IDs from Session B, missing/wrong CSRF, forged human actor, customer-note HTML/Markdown/system prompts, unknown fields, Unicode/long search, rate limiting, and log redaction. Assert identical 404 for missing and cross-Session IDs.

- [ ] **Step 2: Run security suites and verify the missing controls fail**

Run: `npx vitest run test/security`

Expected: FAIL because rate-limit buckets and the safe structured logger do not exist.

- [ ] **Step 3: Implement the demonstrated security controls**

Create `rate-limit.ts` with separate `search`, `eligibility`, and `write` buckets keyed by a one-way hash of Session ID plus coarse IP prefix; return `RATE_LIMITED`, `retryable: true`, and a bounded retry time. Create `safe-logger.ts` with an allowlist of `requestId`, `correlationId`, route template, status, duration, error code, and entity type; reject/log-test any Cookie, CSRF, email, note, prompt, or stack field.

```ts
export type RateLimitKind = "search" | "eligibility" | "write";
export async function consumeRateLimit(db: D1Database, kind: RateLimitKind, digest: string, now: Date): Promise<void> {
  const result = await updateBucket(db, kind, digest, now);
  if (!result.allowed) throw new DomainError("RATE_LIMITED", 429, true, "retry_after");
}

const LOG_FIELDS = new Set(["requestId", "correlationId", "route", "status", "durationMs", "errorCode", "entityType"]);
```

- [ ] **Step 4: Implement fixed-seed Playwright flows**

Each test resets its own Session and asserts API-visible final facts, not only Toast text. Cover refund, exchange committed reservation, credit consent, needs_review child snapshot, reject/replace/expire/invalidate, two-tab approval, retry with same idempotency key, Reset isolation, keyboard/focus/live-region basics.

```ts
test("exchange commits exactly one inventory reservation", async ({ page, request }) => {
  await runExchangeFlow(page, "#1042", "BLUE-M");
  const facts = await request.get("/api/v1/cases/case_exchange").then(r => r.json());
  expect(facts.data.rma.status).toBe("completed");
  expect(facts.data.inventoryReservation.status).toBe("committed");
});
```

- [ ] **Step 5: Implement the ten-case Agent eval runner**

Store each case as `{ id, prompt, expectedTools, allowedAlternatives, forbiddenTools, finalAssertions }`. The scorer consumes exported JSONL invocation traces; CI uses deterministic traces produced by the contract harness, while headed Chrome/ChatGPT runs export real traces for the same scorer. It fails any discovery of a human capability, unsafe response to prompt injection, first-result auto-selection, missing-information guess, or proposal submission from needs_review. The application still contains no LLM dependency.

```js
for (const evaluation of cases) {
  const trace = traces.get(evaluation.id);
  assertNoForbiddenTools(trace, evaluation.forbiddenTools);
  assertAllowedSequence(trace, evaluation.expectedTools, evaluation.allowedAlternatives);
  assertFinalFacts(trace, evaluation.finalAssertions);
}
```

`export-agent-trace.mjs` reads only safe Activity events and final Case facts for a specified seeded eval Case; it never exports customer notes, full messages, prompts, cookies, or tokens.

- [ ] **Step 6: Run the full quality gate and commit**

Run:

```bash
npm run check
npm run test:e2e
node scripts/run-agent-eval.mjs test/eval/traces/ci.jsonl
git add playwright.config.ts e2e test/security test/eval scripts/export-agent-trace.mjs scripts/run-agent-eval.mjs worker/http/rate-limit.ts worker/http/safe-logger.ts
git commit -m "test: cover secure returns workflows"
```

Expected: all automated suites pass; no forbidden tool is discoverable.

---

### Task 14: Deploy, Smoke Test, and Prepare Competition Deliverables

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `scripts/deployment-smoke.mjs`
- Create: `scripts/verify-security-headers.mjs`
- Create: `README.md`
- Create: `LICENSE`
- Create: `docs/demo-script.md`
- Create: `docs/deployment.md`
- Create: `docs/agent-eval-report.md`
- Create: `docs/devpost-draft.md`
- Create: `docs/video-shot-list.md`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Consumes: all build/test/deploy commands.
- Produces: reproducible CI, production D1/deployment steps, security/WebMCP smoke evidence, and submission-ready documentation.

- [ ] **Step 1: Add a failing deployment smoke against local preview**

The script must verify health, bootstrap cookie flags, CSP, six-tool headed registration, missing human tools, Session isolation, one refund flow, Reset scope, and SPA fallback. It exits nonzero on any mismatch.

- [ ] **Step 2: Provision production D1, then add CI and deployment configuration**

Run `npx wrangler d1 create returns-desk` once. Copy the returned immutable database ID into `env.production.d1_databases[0].database_id` in `wrangler.jsonc`, with binding `DB` and database name `returns-desk`; do not change the local binding. CI runs `npm ci`, `npm run check`, migrations against an empty local D1, security tests, Playwright, and artifact upload for test reports. Deployment docs use `wrangler d1 migrations apply returns-desk --remote --env production` before `npm run deploy -- --env production`; secrets are configured through Wrangler secrets, never committed vars.

- [ ] **Step 3: Write exact operational and submission docs**

README includes architecture, local setup, migration/seed/reset commands, Demo-only disclaimer, WebMCP headed flag/origin-trial requirements, test commands, the MIT license, and known callback-signal compatibility behavior. `LICENSE` uses the standard MIT text with `Copyright (c) 2026 Returns Desk contributors`. `docs/demo-script.md` follows the approved 0:00–3:00 timeline. Devpost/video docs use only verified capabilities.

- [ ] **Step 4: Execute release candidate verification**

Run:

```bash
npm ci
npm run check
npx wrangler d1 migrations apply returns-desk --local
npm run test:e2e
node scripts/run-agent-eval.mjs test/eval/traces/ci.jsonl
npm run deploy
node scripts/deployment-smoke.mjs "$env:RETURNS_DESK_BASE_URL"
node scripts/verify-security-headers.mjs "$env:RETURNS_DESK_BASE_URL"
```

Before running the last two commands, set `RETURNS_DESK_BASE_URL` to the exact URL printed by `wrangler deploy`. Expected: all local and deployed checks exit 0; both scripts reject an empty, non-HTTPS, or non-Returns-Desk URL.

- [ ] **Step 5: Perform the two-browser manual release gate and commit**

Run the three-minute script once against seeded Case `case_eval_chrome` in headed target Chrome and once against seeded Case `case_eval_chatgpt` in ChatGPT in-app browser. Export sanitized invocation traces to `artifacts/agent-eval/chrome-release.jsonl` and `artifacts/agent-eval/chatgpt-release.jsonl`; keep `artifacts/` ignored by Git. Export and score them with:

```bash
node scripts/export-agent-trace.mjs "$env:RETURNS_DESK_BASE_URL" case_eval_chrome artifacts/agent-eval/chrome-release.jsonl
node scripts/export-agent-trace.mjs "$env:RETURNS_DESK_BASE_URL" case_eval_chatgpt artifacts/agent-eval/chatgpt-release.jsonl
node scripts/run-agent-eval.mjs artifacts/agent-eval/chrome-release.jsonl
node scripts/run-agent-eval.mjs artifacts/agent-eval/chatgpt-release.jsonl
```

Record date, browser/build, discovered tool list, scorer result, and evidence link in `docs/agent-eval-report.md`.

Then run:

```bash
git add .github README.md LICENSE docs scripts wrangler.jsonc
git commit -m "docs: prepare returns desk release"
```

Expected: repository, deployment, Demo, video, and submission materials all describe the same verified product.

---

## Final Acceptance Checklist

- [ ] Fresh clone: `npm ci && npm run check` passes.
- [ ] Empty D1 migration and deterministic Session seed pass.
- [ ] Policy matrix, proposal state machine, atomic approval, concurrency, and Reset tests pass.
- [ ] HTTP fixture snapshots match the detailed contract.
- [ ] Exactly six WebMCP tools are discoverable with the approved annotations; no human capability is exposed.
- [ ] WebMCP writes synchronize the Case by server entity version or explicitly report `refresh_required` without repeating the write.
- [ ] Cross-Session, CSRF, Origin, prompt injection, XSS, log privacy, and rate-limit tests pass.
- [ ] Refund, exchange, store credit, needs_review, terminal proposal states, retry, and Reset E2E scenarios pass.
- [ ] Headed target Chrome and ChatGPT in-app browser each complete the three-minute Demo.
- [ ] README and submission documents clearly label all side effects as simulated.

## Reference Material

- `项目设计/完整规格.md`
- `项目设计/API与WebMCP详细契约.md`
- `项目设计/政策规则与资格判定.md`
- `项目设计/RMA状态机.md`
- `项目设计/安全与测试设计.md`
- Cloudflare React + Vite guide: `https://developers.cloudflare.com/workers/framework-guides/web-apps/react/`
- Cloudflare D1 Worker API: `https://developers.cloudflare.com/d1/worker-api/d1-database/`
- Cloudflare Workers Vitest integration: `https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/`
- WebMCP draft: `https://webmachinelearning.github.io/webmcp/`
- Chrome WebMCP imperative API: `https://developer.chrome.com/docs/ai/webmcp/imperative-api`
