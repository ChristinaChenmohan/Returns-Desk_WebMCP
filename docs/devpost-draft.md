# Devpost draft

## Returns Desk — agents prepare, humans decide

Returns Desk turns a returns workflow into a safe agent-ready workspace. Six WebMCP tools let an agent search Demo orders, read the policy locked to an order item, calculate deterministic eligibility, compare only allowed resolutions, draft an unsent customer message, and submit a pending RMA proposal.

The critical boundary is deliberately visible: WebMCP cannot approve, reject, review eligibility, replace a proposal, reset a Session, or edit policy. A human reviews a structured side-effect summary and explicitly confirms before an atomic D1 batch records a completed Demo RMA and its simulated refund, store credit, exchange reservation, or return label.

Every repository query is scoped to an anonymous Session. Writes require CSRF, same-origin, signed capability tokens, expected seed/entity versions, and idempotency keys. Customer text stays plain text and logs use an allowlist. The application contains no LLM dependency; policy and money are calculated by deterministic domain services shared by UI and tools.

The project includes 199 Worker/unit/integration/contract/security tests, 8 UI tests, 9 Playwright flows, a Chromium WebMCP compatibility smoke, and a deterministic ten-case agent trace scorer. Production deployment and native Chrome/ChatGPT manual evidence must be added only after Cloudflare authentication and the two-browser release gate.
