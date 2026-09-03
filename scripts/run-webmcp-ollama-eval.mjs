import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { createBackend } from "webmcp-evals/dist/backends/index.js";
import {
  BrowserToolRegistry,
  PUPPETEER_FLAGS,
} from "webmcp-evals/dist/evaluator/browser.js";
import { renderWebmcpReport } from "webmcp-evals/dist/report/report.js";
import { evaluateExecutionTrajectory } from "webmcp-evals/dist/utils.js";
import { buildBrowserLaunchOptions, parseRunnerArgs, runOllamaToolLoop, validateDemoUrl } from "./webmcp-ollama-runner-lib.mjs";

const cli = parseRunnerArgs(process.argv.slice(2));
const baseUrl = cli.baseUrl ?? process.env.RETURNS_DESK_BASE_URL;
if (!baseUrl) {
  throw new Error("Usage: npm run test:webmcp:ollama -- [--headed] [--hold-open=15] https://YOUR-RETURNS-DESK-URL");
}

const parsedUrl = validateDemoUrl(baseUrl);

const model = process.env.OLLAMA_MODEL ?? "qwen3:4b-instruct";
const headed = cli.headed || process.env.WEBMCP_HEADED === "1";
const holdOpenSeconds = cli.holdOpenSeconds || (headed ? 15 : 0);
const stepDelayMs = headed ? Number(process.env.WEBMCP_STEP_DELAY_MS ?? 1800) : 0;
const evalsFile = "test/eval/webmcp-ollama-live.json";
const outputDir = resolve("artifacts/agent-eval/ollama");
const tests = JSON.parse(await readFile(resolve(evalsFile), "utf8"));
const config = {
  backend: "ollama",
  model,
  runs: 1,
  chromeChannel: "chrome-canary",
  headed,
  url: parsedUrl.href,
  evalsFile,
  toolSchemaFile: parsedUrl.href,
};

PUPPETEER_FLAGS.splice(0, PUPPETEER_FLAGS.length,
  "--enable-experimental-web-platform-features",
  "--enable-features=WebMCPTesting,DevToolsWebMCPSupport",
  "--no-sandbox",
  "--disable-setuid-sandbox",
);

const backend = createBackend(config);

// webmcp-evals 0.0.4 exposes an Ollama backend but leaves its browser method
// unimplemented. Keep the adapter local and reuse the package's browser
// registry, matcher, trajectory builder, and standard report renderer.
backend.executeInBrowserEval = async (test, registry) => {
  const availableTools = registry.getCurrentTools();
  const page = registry.page;
  const prompt = test.messages.find(message => message.role === "user" && message.type === "message")?.content ?? test.name;
  const history = [];
  const demoFacts = {};
  await renderAgentOverlay(page, { prompt, history, state: "Ollama is planning the workflow…" });
  const evaluation = await runOllamaToolLoop({
    initialMessages: test.messages,
    availableTools,
    execute: (messages, tools) => backend.execute(messages, tools),
    executeTool: (name, args) => registry.executeToolChecked(name, args),
    buildContinuation: ({ call }) => buildDemoContinuation(call, demoFacts),
    maxSteps: 8,
    onStep: async ({ index, call }) => {
      history.push({ name: call.functionName, args: call.args, result: compactResult(call.result) });
      await synchronizeDemoView(page, call);
      await renderAgentOverlay(page, { prompt, history, state: `Step ${index} complete · uiSync ${readUiSync(call.result)}` });
      console.log(`  ${index}. ${call.functionName} ${JSON.stringify(call.args)} -> ${readUiSync(call.result)}`);
      if (stepDelayMs > 0) await new Promise(resolve => setTimeout(resolve, stepDelayMs));
    },
  });
  await renderAgentOverlay(page, { prompt, history, state: `Complete · ${evaluation.text ?? "Stopped for human approval"}` });
  return { ...evaluation, browserConsoleErrors: registry.getBrowserConsoleErrors() };
};

async function waitForTools(registry, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const tools = registry.getCurrentTools();
    if (tools.length > 0) return tools;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return [];
}

function buildDemoContinuation(call, facts) {
  const data = unwrapData(call.result);
  if (call.functionName === "search_orders") {
    facts.orderId = data?.selectedOrder?.orderId;
    facts.orderItemId = data?.selectedOrder?.items?.[0]?.orderItemId;
    return `Search succeeded. Call get_return_policy next and nothing else. Copy these exact IDs: orderId=${facts.orderId}, orderItemId=${facts.orderItemId}.`;
  }
  if (call.functionName === "get_return_policy") {
    return `Policy read succeeded. Call check_return_eligibility next and nothing else with orderId=${facts.orderId}, orderItemId=${facts.orderItemId}, requestedQuantity=1, reasonCode=wrong_size, conditionCode=opened_unused, storeCreditConsent=true, idempotencyKey=demo-eligibility-ord1001.`;
  }
  if (call.functionName === "check_return_eligibility") {
    facts.caseId = data?.caseId;
    facts.eligibilityCheckId = data?.eligibilityCheckId;
    return `Eligibility succeeded. Do not call check_return_eligibility again. Call compare_resolution_options next and nothing else with eligibilityCheckId=${facts.eligibilityCheckId}, preference=customer_value.`;
  }
  if (call.functionName === "compare_resolution_options") {
    return `Comparison succeeded. Call draft_customer_message next and nothing else with caseId=${facts.caseId}, eligibilityCheckId=${facts.eligibilityCheckId}, resolutionType=refund, tone=warm, locale=en-US.`;
  }
  if (call.functionName === "draft_customer_message") {
    facts.subject = data?.subject;
    facts.bodyText = data?.bodyText;
    return `Draft succeeded. Call submit_rma_for_approval next and nothing else with caseId=${facts.caseId}, eligibilityCheckId=${facts.eligibilityCheckId}, resolutionType=refund, customerMessage.locale=en-US, idempotencyKey=demo-proposal-ord1001. Copy customerMessage.subject and customerMessage.bodyText exactly from the immediately preceding tool JSON.`;
  }
  if (call.functionName === "submit_rma_for_approval") {
    return "The proposal is pending human review. Make no more tool calls. Briefly report completion and stop.";
  }
  return "Continue the original workflow using the latest real tool result.";
}

async function executeLiveEvals() {
  const browser = await puppeteer.launch(buildBrowserLaunchOptions({
    headed,
    chromeChannel: config.chromeChannel,
    flags: PUPPETEER_FLAGS,
  }));
  const rows = [];
  try {
    for (const test of tests) {
      let page;
      let registry;
      try {
        page = await browser.newPage();
        await page.goto(config.url, { waitUntil: "networkidle2", timeout: 30_000 });
        registry = new BrowserToolRegistry(page);
        const tools = await waitForTools(registry);
        if (tools.length === 0) throw new Error(`No WebMCP tools registered on ${config.url}`);

        const evaluation = await backend.executeInBrowserEval(test, registry);
        const matches = evaluateExecutionTrajectory(test.expectedCall ?? [], evaluation.toolCalls);
        const consoleErrors = evaluation.browserConsoleErrors ?? [];

        if (matches.length === 0) {
          rows.push({
            test,
            response: { text: evaluation.text },
            outcome: "pass",
            trajectory: evaluation.steps,
            ...(consoleErrors.length > 0 ? { browserConsoleErrors: consoleErrors } : {}),
            runIndex: 1,
            stepIndex: 1,
          });
        } else {
          matches.forEach((match, index) => {
            const response = match.actual
              ?? (evaluation.toolCalls.length === 0 && evaluation.text
                ? { text: evaluation.text }
                : { missing: "Did not execute this step" });
            rows.push({
              test: {
                name: test.name,
                messages: test.messages,
                expectedCall: match.expected ? [match.expected] : null,
              },
              response,
              outcome: match.outcome,
              trajectory: evaluation.steps,
              ...(index === 0 && consoleErrors.length > 0
                ? { browserConsoleErrors: consoleErrors }
                : {}),
              runIndex: 1,
              stepIndex: index + 1,
            });
          });
        }
      } catch (error) {
        rows.push({
          test,
          response: null,
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
          ...(registry?.getBrowserConsoleErrors().length
            ? { browserConsoleErrors: registry.getBrowserConsoleErrors() }
            : {}),
          runIndex: 1,
          stepIndex: 1,
        });
      } finally {
        if (headed && holdOpenSeconds > 0 && page) {
          console.log(`Keeping the demo browser open for ${holdOpenSeconds}s…`);
          await new Promise(resolve => setTimeout(resolve, holdOpenSeconds * 1000));
        }
        await page?.close();
      }
    }
  } finally {
    await browser.close();
  }

  return {
    results: rows,
    testCount: rows.length,
    passCount: rows.filter(row => row.outcome === "pass").length,
    failCount: rows.filter(row => row.outcome === "fail").length,
    errorCount: rows.filter(row => row.outcome === "error").length,
  };
}

async function synchronizeDemoView(page, call) {
  const data = unwrapData(call.result);
  if (call.functionName === "search_orders") {
    await page.goto(new URL("/orders", parsedUrl).href, { waitUntil: "networkidle2", timeout: 30_000 });
    await page.waitForSelector("#search");
    await page.type("#search", String(call.args.query ?? "ORD-1001"));
    await page.click(".search-bar button");
    await page.waitForSelector(".order-result");
    await page.click(".order-result");
    await page.waitForSelector("select option[value]:not([value=''])");
    return;
  }
  if (call.functionName === "check_return_eligibility" && typeof data?.caseId === "string") {
    await page.goto(new URL(`/cases/${encodeURIComponent(data.caseId)}`, parsedUrl).href, { waitUntil: "networkidle2", timeout: 30_000 });
    await page.waitForFunction(() => document.body.textContent?.includes("CASE WORKSPACE"));
    return;
  }
  if (call.functionName === "submit_rma_for_approval") {
    await page.waitForFunction(() => document.body.textContent?.includes("pending"), { timeout: 10_000 });
    if (stepDelayMs > 0) await new Promise(resolve => setTimeout(resolve, stepDelayMs));
    await page.goto(new URL("/approvals", parsedUrl).href, { waitUntil: "networkidle2", timeout: 30_000 });
    await page.waitForFunction(() => document.body.textContent?.includes("ORD-1001"));
  }
}

async function renderAgentOverlay(page, snapshot) {
  await page.evaluate(({ prompt, history, state }) => {
    const id = "ollama-webmcp-demo-overlay";
    document.getElementById(id)?.remove();
    const overlay = document.createElement("aside");
    overlay.id = id;
    overlay.setAttribute("aria-label", "Ollama WebMCP Agent trace");
    overlay.style.cssText = "position:fixed;right:18px;bottom:18px;width:410px;max-height:52vh;overflow:auto;z-index:2147483647;background:rgba(8,24,22,.96);color:#f5f3e9;border:1px solid #c9a85b;border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.34);padding:16px;font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace";
    const title = document.createElement("strong");
    title.textContent = "LOCAL OLLAMA · WEBMCP AGENT";
    title.style.cssText = "display:block;color:#f4d58d;margin-bottom:8px;letter-spacing:.06em";
    const promptNode = document.createElement("div");
    promptNode.textContent = prompt;
    promptNode.style.cssText = "font-family:system-ui,sans-serif;margin-bottom:10px;color:#dce9e4";
    const stateNode = document.createElement("div");
    stateNode.textContent = state;
    stateNode.style.cssText = "padding:7px 9px;background:#173d36;border-radius:8px;margin-bottom:8px;color:#bdebdc";
    overlay.append(title, promptNode, stateNode);
    for (const [index, step] of history.entries()) {
      const row = document.createElement("div");
      row.style.cssText = "border-top:1px solid rgba(255,255,255,.12);padding-top:7px;margin-top:7px";
      const name = document.createElement("div");
      name.textContent = `${index + 1}. ${step.name}`;
      name.style.color = "#f4d58d";
      const detail = document.createElement("div");
      detail.textContent = `${JSON.stringify(step.args)} → ${JSON.stringify(step.result)}`;
      detail.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#b8cbc5";
      row.append(name, detail);
      overlay.append(row);
    }
    document.body.append(overlay);
  }, snapshot);
}

function unwrapData(result) {
  if (typeof result === "string") {
    try { return JSON.parse(result).data; } catch { return undefined; }
  }
  return result?.data;
}

function readUiSync(result) {
  if (typeof result === "string") {
    try { return JSON.parse(result).uiSync ?? "n/a"; } catch { return "n/a"; }
  }
  return result?.uiSync ?? "n/a";
}

function compactResult(result) {
  const data = unwrapData(result);
  return {
    uiSync: readUiSync(result),
    status: data?.status,
    orderNumber: data?.selectedOrder?.orderNumber ?? data?.orders?.[0]?.orderNumber,
    caseId: data?.caseId,
    eligibilityCheckId: data?.eligibilityCheckId,
    proposalId: data?.proposalId,
  };
}

const results = await executeLiveEvals();
for (const result of results.results) {
  console.log(`${result.outcome.toUpperCase()}: ${result.test.name}`);
  if (result.error) console.error(result.error);
}

await mkdir(outputDir, { recursive: true });
const timestamp = new Date().toISOString().replaceAll(":", "-");
const jsonPath = resolve(outputDir, `report-${timestamp}.json`);
const htmlPath = resolve(outputDir, `report-${timestamp}.html`);
await writeFile(jsonPath, JSON.stringify({ config, results }, null, 2));
await writeFile(htmlPath, renderWebmcpReport(config, results));

console.log(`WebMCP Ollama eval: ${results.passCount}/${results.testCount} passed`);
console.log(`JSON report: ${jsonPath}`);
console.log(`HTML report: ${htmlPath}`);

if (results.failCount > 0 || results.errorCount > 0) process.exitCode = 1;
