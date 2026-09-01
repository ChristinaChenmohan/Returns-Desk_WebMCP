# Three-minute Demo script

## 0:00–0:30 — Safe workspace

Open the dashboard. State that all commerce effects are simulated and every visitor receives an isolated anonymous Demo Session. Show the five routes and the Reset control.

## 0:30–1:05 — Agent gathers facts

Ask the agent to search `ORD-1001`. Show that it does not auto-select ambiguous search results. Select the order, read its locked policy, and run eligibility using quantity, reason, and condition supplied by the user.

## 1:05–1:35 — Options and pending proposal

Compare only server-allowed resolutions. Draft a warm, unsent message and submit a refund proposal. Point out that the agent stops at `pending`: no payment, message, inventory, label, or shipment has occurred.

## 1:35–2:10 — Explicit human approval

Open **Review & approve**. Read the quantity, resolution, amount, return requirement, and simulated effects. Check the confirmation and approve. Show one completed Demo RMA, one simulated refund, and one simulated return label in the Case facts/activity.

## 2:10–2:35 — Human judgment branch

Open `ORD-1002`, choose damaged reason and condition, and run eligibility. Show `needs_review`, absence of proposal submission, and the human-only structured review dialog. Approve the eligibility exception to create a child snapshot.

## 2:35–3:00 — Safety evidence

Show the six discovered WebMCP tools and confirm no approve, reject, review, replace, Reset, or policy-write tool exists. Mention Session isolation, CSRF/Origin checks, idempotency, atomic D1 approval, and sanitized logs. End with Reset Demo and the Demo-only disclaimer.
