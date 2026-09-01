import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createBackend } from "webmcp-evals/dist/backends/index.js";
import {
  BrowserToolRegistry,
  launchBrowser,
  PUPPETEER_FLAGS,
} from "webmcp-evals/dist/evaluator/browser.js";
import { renderWebmcpReport } from "webmcp-evals/dist/report/report.js";
import { evaluateExecutionTrajectory } from "webmcp-evals/dist/utils.js";

const baseUrl = process.argv[2] ?? process.env.RETURNS_DESK_BASE_URL;
if (!baseUrl) {
  throw new Error("Usage: npm run test:webmcp:ollama -- https://YOUR-RETURNS-DESK-URL");
}

const parsedUrl = new URL(baseUrl);
if (parsedUrl.protocol !== "https:") throw new Error("The live eval requires an HTTPS URL");

const model = process.env.OLLAMA_MODEL ?? "qwen3:4b-instruct";
const evalsFile = "test/eval/webmcp-ollama-live.json";
const outputDir = resolve("artifacts/agent-eval/ollama");
const tests = JSON.parse(await readFile(resolve(evalsFile), "utf8"));
const config = {
  backend: "ollama",
  model,
  runs: 1,
  chromeChannel: "chrome-canary",
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
  const selection = await backend.execute(test.messages, availableTools);
  const executedCalls = [];
  const toolCalls = [];
  const toolResults = [];

  for (const call of selection.toolCalls) {
    const outcome = await registry.executeToolChecked(call.functionName, call.args);
    if (!outcome.success) throw new Error(`${call.functionName}: ${outcome.error}`);

    executedCalls.push({
      functionName: call.functionName,
      args: call.args,
      result: outcome.result,
    });
    toolCalls.push({ toolName: call.functionName, input: call.args });
    toolResults.push({ toolName: call.functionName, output: outcome.result });
  }

  return {
    toolCalls: executedCalls,
    text: selection.text,
    steps: [{ text: selection.text, toolCalls, toolResults, availableTools }],
    browserConsoleErrors: registry.getBrowserConsoleErrors(),
  };
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

async function executeLiveEvals() {
  const browser = await launchBrowser(config.chromeChannel);
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