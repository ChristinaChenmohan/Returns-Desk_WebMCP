# Returns Desk

Returns Desk is a Demo-only returns workspace for Cloudflare Workers. A React UI and six WebMCP tools share deterministic domain services over a Session-isolated D1 database. Agents may inspect facts, calculate eligibility, compare resolutions, draft an unsent message, and submit a pending proposal. Only explicit human UI actions can review, approve, reject, replace, edit policy drafts, or reset the Demo.

No real payment, email, commerce, shipping, inventory, or logistics system is connected. Every refund, credit, label, reservation, tracking number, and RMA is simulated.

## Architecture

- React, React Router, TanStack Query, and Vite provide five accessible workspace routes.
- A Hono Worker exposes the versioned `/api/v1` contract.
- D1 repositories scope every query by anonymous Session and enforce atomic approval guards.
- Six static WebMCP tools are progressive enhancement through `document.modelContext`; the human UI works without WebMCP.
- Signed human/agent channel tokens, CSRF and Origin checks, version guards, idempotency records, rate limits, CSP, and privacy-safe logs protect command boundaries.

## Local setup

Requirements: Node.js 22+, npm, and Chromium for Playwright.

```bash
npm ci
npx playwright install chromium
npx wrangler d1 migrations apply returns-desk --local
npm run dev
```

For the production-style local Worker at `http://127.0.0.1:8787`:

```bash
node scripts/local-preview.mjs
```

The preview command builds first, applies local migrations, then starts Wrangler with a local-only signing key. Use **Reset Demo** in the UI to rebuild only the current browser Session.

## Verification

```bash
npm run check
npm run test:e2e
npm run test:webmcp
npm run test:agent-eval
```

`npm run check` runs strict TypeScript, 199 Worker/unit/integration/contract/security tests, 8 UI tests, and the production build. Playwright covers the nine fixed-seed browser flows. The WebMCP smoke uses Chromium with a compatibility ModelContext to verify six registrations, annotations, execution, `toolchange`, and abort cleanup. Live WebMCP agent acceptance was completed in Chrome Canary.

A no-paid-API live agent lane uses Chrome Canary, WebMCP Evals, and local Ollama:

```bash
ollama pull qwen3:4b-instruct
npm run test:webmcp:ollama -- https://returns-desk-production.chenmohan2006.workers.dev
npm run demo:webmcp:ollama -- https://returns-desk-production.chenmohan2006.workers.dev
```

See [docs/ollama-webmcp-evals.md](docs/ollama-webmcp-evals.md) for prerequisites, report locations, model overrides, and the `webmcp-evals@0.0.4` compatibility note.

## WebMCP compatibility

The app feature-detects `document.modelContext?.registerTool`. Browsers without the API receive the complete human UI. A target browser build or origin-trial/flag configuration may be required while WebMCP remains experimental. Callback `AbortSignal` is forwarded best-effort; correctness relies on server idempotency, conditional writes, constraints, and D1 atomic batches.

## Deployment

Production deployment requires an authenticated Cloudflare account, a provisioned D1 database ID, and a Wrangler secret named `CHANNEL_SIGNING_KEY`. `npm run deploy` builds with `CLOUDFLARE_ENV=production` before invoking Wrangler. Follow [docs/deployment.md](docs/deployment.md). Never commit secrets or invent a D1 ID.

## License

MIT. See [LICENSE](LICENSE).
