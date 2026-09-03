# Ollama + WebMCP Evals

This lane evaluates the deployed Returns Desk tools with a local LLM. It does not require or call Gemini, OpenAI, Anthropic, or another paid model API.

## Requirements

- Node.js 22+
- Chrome Canary 151+ (the runner enables the required experimental WebMCP and DevTools feature flags)
- Ollama listening on `http://127.0.0.1:11434`
- The local `qwen3:4b-instruct` model (about 2.5 GB)

On Windows, install Ollama, open a new terminal, and prepare the model:

```powershell
ollama pull qwen3:4b-instruct
ollama list
```

If the Ollama application is not already running:

```powershell
ollama serve
```

## Record the visible agent demo

Start Ollama, then run:

```powershell
ollama serve
npm run demo:webmcp:ollama -- https://returns-desk-production.chenmohan2006.workers.dev
```

The runner opens a visible Chrome Canary window at 1500×940, shows an injected `LOCAL OLLAMA · WEBMCP AGENT` trace card, and pauses between calls so the six-step workflow can be recorded. It searches `ORD-1001`, reads the locked policy, checks eligibility, compares resolutions, drafts an unsent message, and submits a `pending` refund proposal. The final page is the Approval Queue and remains open for 20 seconds.

Set `WEBMCP_STEP_DELAY_MS` to control the delay between calls. Use `--hold-open=N` when invoking the Node script directly to change the final hold duration.

## Run the headless live evaluation

```powershell
npm ci
npm run test:webmcp:ollama -- https://returns-desk-production.chenmohan2006.workers.dev
```

Alternatively, set `RETURNS_DESK_BASE_URL` and omit the URL argument. Override the local model with `OLLAMA_MODEL` when needed.

The command launches headless Chrome Canary, waits for the page to register WebMCP tools, sends the registered schemas and the natural-language workflow prompt to local Ollama, feeds each real tool result back into the next model turn, and checks all six calls with the WebMCP Evals matcher. Timestamped JSON and HTML reports are written to `artifacts/agent-eval/ollama/`; that directory is intentionally ignored by Git because reports contain per-session demo identifiers.

## Compatibility note

`webmcp-evals@0.0.4` provides an Ollama backend, but its browser execution method is not implemented and its browser loop can inspect tools before this React application finishes registration. `scripts/run-webmcp-ollama-eval.mjs` is a repository-local adapter that preserves the package's backend, browser registry, matcher, trajectory format, and report renderer while adding current Canary flags and a bounded registration wait. It does not modify `node_modules`.

## Verified result

On 2026-09-01, Chrome Canary 154.0.8035.0 and Ollama 0.33.2 with `qwen3:4b-instruct` passed the original single-call search acceptance against the production URL. On 2026-09-03, the expanded headed runner passed all 6/6 expected calls against a local HTTPS Wrangler build. Every call reported `uiSync: "synchronized"`; the final proposal reached `pending` and the browser stopped on the Approval Queue without executing approval.

```json
{
  "functionName": "search_orders",
  "args": { "query": "ORD-1001", "limit": 5 }
}
```

The browser executed the tool and returned one matching order with `uiSync: "synchronized"`.
