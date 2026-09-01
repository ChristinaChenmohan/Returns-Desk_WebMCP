# Deployment

## Prerequisites

Use Node.js 22+, an authenticated Wrangler CLI, and a Cloudflare account permitted to create Workers and D1 databases. All effects remain Demo-only.

## Production setup

1. Run `npx wrangler login` and verify with `npx wrangler whoami`.
2. Confirm the already-provisioned `returns-desk` D1 database is visible with `npx wrangler d1 list`. Do not create it again.
3. Create a high-entropy secret with `npx wrangler secret put CHANNEL_SIGNING_KEY --env production`.
4. Keep the checked-in `env.production` D1 binding and `APP_ENV=production` configuration unchanged unless the Cloudflare resource is deliberately replaced.

The production D1 binding was generated from the provisioned Cloudflare database ID and validated with `npm run deploy -- --dry-run`. The signing secret is never committed.

## Release

```bash
npm ci
npm run check
npx wrangler d1 migrations apply returns-desk --local
npm run test:e2e
npm run test:webmcp
npm run test:agent-eval
npx wrangler d1 migrations apply returns-desk --remote --env production
npm run deploy
```

`npm run deploy` sets `CLOUDFLARE_ENV=production` during the Vite build, then deploys the flattened production configuration. Do not replace it with `wrangler deploy --env production`; the Cloudflare Vite plugin selects environments at build time.

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
