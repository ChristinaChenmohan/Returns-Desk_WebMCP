# Deployment

## Prerequisites

Use Node.js 22+, an authenticated Wrangler CLI, and a Cloudflare account permitted to create Workers and D1 databases. All effects remain Demo-only.

## One-time production setup

1. Run `npx wrangler login` and verify with `npx wrangler whoami`.
2. Run `npx wrangler d1 create returns-desk` exactly once.
3. Add an `env.production` block to `wrangler.jsonc` whose `d1_databases` entry uses binding `DB`, database name `returns-desk`, and the exact immutable database ID returned above. Do not replace the top-level local binding.
4. Create a high-entropy secret with `npx wrangler secret put CHANNEL_SIGNING_KEY --env production`.
5. Set `APP_ENV` to `production` in the production environment.

The production block is intentionally not checked in with a guessed database ID. This checkout has not authenticated to Cloudflare or provisioned production D1.

## Release

```bash
npm ci
npm run check
npx wrangler d1 migrations apply returns-desk --local
npm run test:e2e
npm run test:webmcp
npm run test:agent-eval
npx wrangler d1 migrations apply returns-desk --remote --env production
npm run deploy -- --env production
```

Copy the exact HTTPS URL printed by Wrangler:

```bash
node scripts/deployment-smoke.mjs https://YOUR-RETURNS-DESK-URL
node scripts/verify-security-headers.mjs https://YOUR-RETURNS-DESK-URL
```

Both scripts reject missing and unsafe non-HTTPS remote URLs. The deployment smoke verifies health, secure cookies, a simulated refund, Session isolation, Reset behavior, SPA fallback, and the six-tool browser contract.

## Rollback and operations

- Deploy a previously verified Git commit; migrations are additive and must not be rolled back by deleting production data.
- Rotate `CHANNEL_SIGNING_KEY` through Wrangler secrets if exposed. Existing short-lived channel tokens will stop validating.
- Logs contain only allowlisted correlation, route-template, status, duration, error-code, and entity-type fields.
- Never put cookies, CSRF values, channel tokens, customer notes, prompts, email addresses, or stack traces in logs or artifacts.
