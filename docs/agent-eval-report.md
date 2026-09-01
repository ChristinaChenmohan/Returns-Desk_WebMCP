# Agent evaluation report

## Automated evidence

Recorded 2026-09-01 against commit baseline `7f2997e` plus the Task 7–14 completion changes in this working tree.

- Deterministic scorer: **10/10 passed**
- Discovered tools: `search_orders`, `get_return_policy`, `check_return_eligibility`, `compare_resolution_options`, `draft_customer_message`, `submit_rma_for_approval`
- Human capabilities discovered: **none**
- Chromium compatibility smoke: six registrations, annotations, strict schemas, real search execution, `toolchange`, and abort cleanup passed
- CI trace: `test/eval/traces/ci.jsonl`

Cases cover ambiguous selection, refund, exchange, store-credit consent, needs-review, prompt injection, missing information, ineligibility, safe retry, and the human approval boundary.

## Manual release gates

Not yet claimed:

| Target | Date/build | Native tools | Scorer | Evidence |
|---|---|---:|---:|---|
| Target Chrome with WebMCP enabled | Pending | Pending | Pending | `artifacts/agent-eval/chrome-release.jsonl` |
| ChatGPT in-app browser | Pending | Pending | Pending | `artifacts/agent-eval/chatgpt-release.jsonl` |

After deployment, run the three-minute script in each target, export sanitized traces with `scripts/export-agent-trace.mjs`, then score them with `scripts/run-agent-eval.mjs`. Do not mark the release gate complete until both rows contain real browser/build identifiers and evidence.
