import { writeFile } from "node:fs/promises";

const [baseUrl, caseId, output] = process.argv.slice(2);
if (!baseUrl || !caseId || !output) throw new Error("Usage: node scripts/export-agent-trace.mjs BASE_URL CASE_ID OUTPUT.jsonl");
const url = new URL(baseUrl);
if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("BASE_URL must be HTTPS (localhost is allowed).");
const suppliedCookie = process.env.RETURNS_DESK_SESSION_COOKIE;
const bootstrap = await fetch(new URL("/api/v1/session/bootstrap", url), { headers: suppliedCookie ? { Cookie: suppliedCookie } : {} });
if (!bootstrap.ok) throw new Error(`Bootstrap failed: ${bootstrap.status}`);
const cookie = suppliedCookie ?? bootstrap.headers.get("set-cookie")?.split(";")[0];
const auth = (await bootstrap.json()).data;
const headers = { Cookie: cookie, "X-Channel-Token": auth.humanChannelToken };
const [workspaceResponse, activityResponse] = await Promise.all([
  fetch(new URL(`/api/v1/cases/${encodeURIComponent(caseId)}`, url), { headers }),
  fetch(new URL(`/api/v1/cases/${encodeURIComponent(caseId)}/activity?limit=100`, url), { headers }),
]);
if (!workspaceResponse.ok || !activityResponse.ok) throw new Error("Case is not available in the supplied session.");
const workspace = (await workspaceResponse.json()).data;
const activity = (await activityResponse.json()).data.items;
const safe = {
  id: caseId,
  invocations: activity.filter(item => item.actorType === "agent").map(item => ({ eventType: item.eventType, entityType: item.entityType })),
  finalFacts: { caseId: workspace.caseId, version: workspace.version, eligibilityStatus: workspace.latestEligibility?.status ?? null, proposalStatus: workspace.proposal?.status ?? null, rmaStatus: workspace.completion?.rma.status ?? null },
};
await writeFile(output, JSON.stringify(safe) + "\n", "utf8");
console.log(`Wrote sanitized trace to ${output}`);
