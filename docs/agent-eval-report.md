# Agent evaluation report

## Automated evidence

Recorded 2026-09-01 against commit baseline `7f2997e` plus the Task 7–14 completion changes in this working tree.

- Deterministic scorer: **10/10 passed**
- Discovered tools: `search_orders`, `get_return_policy`, `check_return_eligibility`, `compare_resolution_options`, `draft_customer_message`, `submit_rma_for_approval`
- Human capabilities discovered: **none**
- Chromium compatibility smoke: six registrations, annotations, strict schemas, real search execution, `toolchange`, and abort cleanup passed
- CI trace: `test/eval/traces/ci.jsonl`
- Local Ollama live eval: **1/1 passed** with Chrome Canary `154.0.8035.0`, Ollama `0.33.2`, and `qwen3:4b-instruct`
- Actual call: `search_orders({ query: "ORD-1001", limit: 5 })`; result count `1`, UI sync `synchronized`
- Timestamped local evidence: `artifacts/agent-eval/ollama/report-2026-09-01T07-35-46.815Z.{json,html}` (Git-ignored because it includes per-session demo IDs)

Cases cover ambiguous selection, refund, exchange, store-credit consent, needs-review, prompt injection, missing information, ineligibility, safe retry, and the human approval boundary.

## Live browser evidence

| Target | Date/build | Native tools | Scorer | Evidence |
|---|---|---:|---:|---|
| Chrome Canary + local Ollama WebMCP Evals | 2026-09-01 / 154.0.8035.0 | 6 | 1/1 | `artifacts/agent-eval/ollama/report-2026-09-01T07-35-46.815Z.json` |

The recorded live run used Chrome Canary with WebMCP enabled. When repeating the release check, export a sanitized Chrome Canary trace with `scripts/export-agent-trace.mjs`, then score it with `scripts/run-agent-eval.mjs`.
