# Returns Desk

**A safe WebMCP-powered returns workspace where an agent can prepare an RMA, but only a human can approve the real business decision.**

Returns Desk turns a realistic ecommerce returns flow into a demo that is intentionally agent-ready: WebMCP tools expose the facts and draft actions an assistant needs, while refunds, labels, messages, policy exceptions, Reset, and final approval stay behind explicit human UI controls.

Live demo: https://returns-desk-production.chenmohan2006.workers.dev

Demo video: add your video link here before submission.

## What It Does

- Lets a human operator handle demo return cases from a five-route React workspace.
- Lets a WebMCP-capable agent search orders, read locked policies, calculate eligibility, compare allowed resolutions, draft an unsent customer message, and submit a pending RMA proposal.
- Keeps every commerce effect simulated: refunds, credits, labels, reservations, tracking numbers, RMA IDs, email, shipping, inventory, and logistics.
- Uses an anonymous Session-scoped D1 database so each visitor can run the demo independently and reset only their own data.

## Why WebMCP

Returns are exactly the kind of workflow WebMCP is meant for: the agent needs structured business tools, not screen scraping, and the human needs a clear boundary around irreversible decisions.

- **Tool-native workflow:** the page registers six typed WebMCP tools through `document.modelContext.registerTool`.
- **Shared business rules:** the human UI and the tools call the same deterministic domain services, so agent suggestions match what the app itself would calculate.
- **Progressive enhancement:** browsers without WebMCP still get the full human UI.
- **Human control:** WebMCP can prepare a proposal, but cannot approve, reject, replace, reset, edit policy, send email, move money, reserve stock, or ship anything.
- **Evaluation-friendly:** the repo includes contract tests, headed browser smoke tests, deterministic agent traces, and a live local-LLM WebMCP eval lane.

## Demo Workflow

1. Search for `ORD-1001`.
2. Select a returnable item and read the locked return policy for that order item.
3. Check eligibility with quantity, reason, condition, and store-credit consent supplied by the human.
4. Compare server-allowed resolution options.
5. Draft a warm unsent customer message.
6. Submit an RMA proposal for human approval.
7. Open **Review & approve** in the UI and make the final human decision.

The important boundary: the agent stops at `pending`. Approval is a separate human action.

## WebMCP Tools

| Tool | What it does | Read-only |
|---|---|---:|
| `search_orders` | Finds demo orders by order number, name, or email; unique matches include item IDs for later tools. | Yes |
| `get_return_policy` | Reads the historical policy version locked to a selected order item. | Yes |
| `check_return_eligibility` | Creates a server-verified eligibility snapshot from human-supplied return details. | No |
| `compare_resolution_options` | Compares only the resolutions allowed by a fresh eligible check. | Yes |
| `draft_customer_message` | Generates a deterministic, unsent customer message for the selected resolution. | Yes |
| `submit_rma_for_approval` | Creates a pending proposal for human review; it does not approve or execute effects. | No |

Forbidden human actions are deliberately not exposed as tools: approve, reject, review exception, replace proposal, edit policy, Reset Demo, refund, send message, reserve inventory, create label, or ship.

## Evidence It Runs

- Production demo is deployed at the live URL above.
- `npm run check` runs strict TypeScript, 199 Worker/unit/integration/contract/security tests, 8 UI tests, and the production build.
- `npm run test:e2e` covers the fixed-seed browser flows.
- `npm run test:webmcp` launches Chromium and verifies six registrations, annotations, strict schemas, real tool execution, `toolchange`, and abort cleanup.
- `npm run test:agent-eval` scores ten deterministic agent traces.
- A no-paid-API live lane ran Chrome Canary + WebMCP Evals + local Ollama and passed with `qwen3:4b-instruct`; see [docs/agent-eval-report.md](docs/agent-eval-report.md).

## Architecture

- **React + Vite UI:** five accessible workspace routes with React Router and TanStack Query.
- **Cloudflare Worker API:** Hono exposes the versioned `/api/v1` contract.
- **D1 persistence:** repositories scope every query by anonymous Session and enforce versioned, atomic approval guards.
- **Shared domain services:** order search, policy reads, eligibility, resolution comparison, message drafting, and proposal submission are reused by UI routes and WebMCP tools.
- **Browser WebMCP registry:** `src/webmcp` feature-detects `document.modelContext`, registers static strict tools, forwards abort signals best-effort, and re-syncs UI state after tool execution.

## Human-in-the-loop / Safety

- Agent writes stop at pending proposals or eligibility snapshots.
- Final approval, rejection, exception review, proposal replacement, policy drafts, and Reset are UI-only human actions.
- Signed human/agent channel tokens separate browser command paths.
- CSRF, Origin checks, version guards, idempotency records, rate limits, CSP, and privacy-safe logs protect command boundaries.
- Customer-provided text is treated as untrusted data, including in tool descriptions and prompt-injection tests.
- There are no real payment, email, commerce, shipping, inventory, or logistics integrations.

## Tech Stack

React 19, React Router, TanStack Query, TypeScript, Vite, Hono, Cloudflare Workers, Cloudflare D1, Zod, Vitest, Playwright, Wrangler, and `webmcp-evals`.

## How to Test WebMCP

Install dependencies and the Playwright browser first:

```bash
npm ci
npx playwright install chromium
```

Run the core verification suite:

```bash
npm run check
npm run test:e2e
npm run test:webmcp
npm run test:agent-eval
```

Run the optional local-LLM live agent lane:

```bash
ollama pull qwen3:4b-instruct
npm run test:webmcp:ollama -- https://returns-desk-production.chenmohan2006.workers.dev
npm run demo:webmcp:ollama -- https://returns-desk-production.chenmohan2006.workers.dev
```

Details: [docs/ollama-webmcp-evals.md](docs/ollama-webmcp-evals.md).

## Run Locally

Requirements: Node.js 22+, npm, Wrangler, and Chromium for Playwright.

```bash
npm ci
npx playwright install chromium
npx wrangler d1 migrations apply returns-desk --local
npm run dev
```

For a production-style local Worker at `http://127.0.0.1:8787`:

```bash
node scripts/local-preview.mjs
```

The preview script builds first, applies local D1 migrations, and starts Wrangler with a local-only signing key. Use **Reset Demo** in the UI to rebuild only the current browser Session.

## Project Structure

```text
src/                    React UI, shared contracts, and browser WebMCP registry
worker/                 Hono Worker routes, middleware, repositories, and domain services
test/                   Vitest unit, integration, contract, security, and agent-eval traces
e2e/                    Playwright browser regression flows
docs/                   Demo script, deployment notes, WebMCP eval docs, and evidence reports
scripts/                Local preview, verification, deployment, and WebMCP eval runners
migrations/             Cloudflare D1 schema migrations
public/                 Static assets
```

## Limitations

- WebMCP is experimental, so a compatible browser build or flag/origin-trial configuration may be required.
- AbortSignal forwarding is best-effort in browser callbacks; correctness relies on server idempotency, conditional writes, constraints, and D1 atomic batches.
- The app is Demo-only and intentionally avoids real commerce integrations.
- Replace the demo-video placeholder before a public submission.

## Deployment

Production deployment requires an authenticated Cloudflare account, a provisioned D1 database ID, and a Wrangler secret named `CHANNEL_SIGNING_KEY`.

```bash
npm run deploy
```

Follow [docs/deployment.md](docs/deployment.md). Never commit secrets or invent a D1 ID.

## License

MIT. See [LICENSE](LICENSE).
