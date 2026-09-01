import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const value = process.argv[2];
if (!value) throw new Error("Usage: node scripts/deployment-smoke.mjs BASE_URL");
const base = new URL(value);
if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") throw new Error("BASE_URL must be HTTPS (localhost is allowed).");
const health = await fetch(new URL("/api/v1/health", base));
assert.equal(health.status, 200);
assert.equal((await health.json()).data.status, "ok");

async function session(cookie) {
  const response = await fetch(new URL("/api/v1/session/bootstrap", base), { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal(response.status, 200);
  if (!cookie) assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly; Secure; SameSite=Lax/u);
  return { auth: (await response.json()).data, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? cookie };
}
const first = await session();
const origin = base.origin;
async function call(path, method = "GET", body, key = crypto.randomUUID(), current = first) {
  const headers = { Cookie: current.cookie, "X-Channel-Token": current.auth.humanChannelToken, "X-CSRF-Token": current.auth.csrfToken, "Idempotency-Key": key, Origin: origin };
  const response = await fetch(new URL(`/api/v1${path}`, base), { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify({ ...body, expectedSeedVersion: current.auth.seedVersion }), headers: { ...headers, "Content-Type": "application/json" } }) });
  const envelope = await response.json();
  return { response, envelope };
}
const search = await call("/orders?query=ORD-1001");
const order = await call(`/orders/${search.envelope.data.orders[0].orderId}`);
const item = order.envelope.data.items[0];
const check = await call("/eligibility-checks", "POST", { orderId: order.envelope.data.orderId, orderItemId: item.orderItemId, requestedQuantity: 1, reasonCode: "wrong_size", conditionCode: "opened_unused" });
assert.equal(check.envelope.data.status, "eligible");
const proposal = await call("/rma-proposals", "POST", { caseId: check.envelope.data.caseId, eligibilityCheckId: check.envelope.data.eligibilityCheckId, resolutionType: "refund", customerMessage: { subject: "Demo refund review", bodyText: "This simulated refund is ready for human review.", locale: "en-US" } });
assert.equal(proposal.envelope.data.status, "pending");
const approval = await call(`/rma-proposals/${proposal.envelope.data.proposalId}/approve`, "POST", { expectedVersion: proposal.envelope.data.version, confirmation: "approve_and_simulate_completion" });
assert.equal(approval.envelope.data.rma.status, "completed");
assert.equal(approval.envelope.data.executedEffects.filter(effect => effect.entityType === "simulated_refund").length, 1);

const second = await session();
const isolated = await call(`/cases/${check.envelope.data.caseId}`, "GET", undefined, undefined, second);
assert.equal(isolated.response.status, 404);
const reset = await call("/session/reset", "POST", { confirmation: "reset_current_demo_session" });
assert.equal(reset.response.status, 200);
const stale = await call(`/cases/${check.envelope.data.caseId}`);
assert.equal(stale.response.status, 403);
const refreshed = await session(first.cookie);
assert.equal(refreshed.auth.seedVersion, first.auth.seedVersion + 1);
const removed = await call(`/cases/${check.envelope.data.caseId}`, "GET", undefined, undefined, refreshed);
assert.equal(removed.response.status, 404);
const spa = await fetch(new URL("/cases/client-side-route", base));
assert.equal(spa.status, 200);
assert.match(spa.headers.get("content-type") ?? "", /text\/html/u);

const webmcp = spawnSync(process.execPath, ["scripts/webmcp-headed-smoke.mjs"], { stdio: "inherit", env: { ...process.env, RETURNS_DESK_BASE_URL: base.href } });
assert.equal(webmcp.status, 0);
console.log("Deployment smoke passed: health, secure session, refund, isolation, reset, SPA, and six WebMCP tools.");
