import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const baseUrl = process.env.RETURNS_DESK_BASE_URL ?? "http://127.0.0.1:8787";
let server;
if (!process.env.RETURNS_DESK_BASE_URL) {
  server = spawn(process.execPath, ["scripts/local-preview.mjs"], { stdio: "inherit", env: process.env });
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(new URL("/api/v1/health", baseUrl))).ok) break; } catch {}
    if (attempt === 119) throw new Error("Local preview did not become ready.");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const registrations = [];
    let changes = 0;
    const context = new EventTarget();
    context.registerTool = (tool, options) => {
      registrations.push({ tool, signal: options.signal });
      context.dispatchEvent(new Event("toolchange"));
    };
    context.addEventListener("toolchange", () => { changes += 1; });
    Object.defineProperty(Document.prototype, "modelContext", { configurable: true, get: () => context });
    window.__webmcpSmoke = { registrations, get changes() { return changes; } };
  });
  await page.goto(baseUrl);
  await page.waitForFunction(() => window.__webmcpSmoke?.registrations.length === 6);
  const first = await page.evaluate(() => window.__webmcpSmoke.registrations.map(({ tool, signal }) => ({
    name: tool.name, readOnlyHint: tool.annotations.readOnlyHint,
    additionalProperties: tool.inputSchema.additionalProperties, aborted: signal.aborted,
  })));
  assert.deepEqual(first.map(item => item.name), ["search_orders","get_return_policy","check_return_eligibility","compare_resolution_options","draft_customer_message","submit_rma_for_approval"]);
  assert.deepEqual(first.map(item => item.readOnlyHint), [true,true,false,true,true,false]);
  assert.ok(first.every(item => item.additionalProperties === false && !item.aborted));
  const search = await page.evaluate(async () => JSON.parse(await window.__webmcpSmoke.registrations[0].tool.execute({ query: "ORD-1001", limit: 5 })));
  assert.equal(search.uiSync, "synchronized");
  assert.equal(search.data.orders[0].orderNumber, "ORD-1001");
  await page.evaluate(() => window.dispatchEvent(new Event("returns-session-reset")));
  await page.waitForFunction(() => window.__webmcpSmoke.registrations.length === 12);
  const lifecycle = await page.evaluate(() => ({
    oldAborted: window.__webmcpSmoke.registrations.slice(0, 6).every(item => item.signal.aborted),
    newActive: window.__webmcpSmoke.registrations.slice(6).every(item => !item.signal.aborted),
    changes: window.__webmcpSmoke.changes,
  }));
  assert.deepEqual(lifecycle, { oldAborted: true, newActive: true, changes: 12 });
  console.log("WebMCP browser smoke passed: six tools, annotations, execution, toolchange, and cleanup.");
} finally {
  await browser.close();
  if (server) server.kill("SIGTERM");
}
