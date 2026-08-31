import { useState } from "react";
import { useApi } from "../app/providers";
import { type Workspace, type MessageDraft, money, label } from "../api/models";
import { ConfirmDialog } from "./ConfirmDialog";
import { useCommand } from "./useCommand";
import { ReturnForm } from "../pages/OrdersPage";

type Action = "prepare" | "approve" | "reject" | "replace" | "review" | "check";
export function CaseActions({ data }: { data: Workspace }) {
  const [action, setAction] = useState<Action | null>(null);
  const [snapshot, setSnapshot] = useState(data);
  function open(action: Action) { setSnapshot(data); setAction(action); }
  const pending = data.proposal?.status === "pending";
  return <section className="panel padded"><h2>04 · Human decisions</h2><p>No payment, message or shipment leaves this demo.</p><div className="actions">
    {data.latestEligibility?.status === "needs_review" && <button onClick={() => open("review")}>Review eligibility</button>}
    {data.latestEligibility?.proposalSubmissionAllowed && !pending && !data.completion && <button className="primary" onClick={() => open("prepare")}>Prepare proposal</button>}
    {pending && <><button className="primary" onClick={() => open("approve")}>Review & approve</button><button onClick={() => open("reject")}>Reject proposal</button><button onClick={() => open("replace")}>Replace proposal</button></>}
    {!pending && !data.completion && <button onClick={() => open("check")}>Run new eligibility check</button>}
  </div>{action && <CaseActionDialog action={action} data={snapshot} changed={data.version !== snapshot.version} onClose={() => setAction(null)}/>}</section>;
}

export function CaseActionDialog({ action, data, changed, onClose }: { action: Action; data: Workspace; changed: boolean; onClose: () => void }) {
  const api = useApi(), command = useCommand(onClose); const check = data.latestEligibility, proposal = data.proposal;
  const [choice, setChoice] = useState(proposal?.resolutionType ?? check?.allowedResolutions[0]?.type ?? "refund");
  const [subject, setSubject] = useState(action === "replace" ? proposal?.customerMessage.subject ?? "" : "");
  const [body, setBody] = useState(action === "replace" ? proposal?.customerMessage.bodyText ?? "" : "");
  const [draftError, setDraftError] = useState(""); const [drafting, setDrafting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const option = check?.allowedResolutions.find(option => option.type === choice);
  const prepare = action === "prepare" || action === "replace";
  const locale = action === "replace" ? proposal?.customerMessage.locale ?? "en-US" : "en-US";
  const base = { caseId: data.caseId, eligibilityCheckId: check?.eligibilityCheckId, resolutionType: choice,
    ...(option?.replacementVariantId ? { replacementVariantId: option.replacementVariantId } : {}) };
  const blocked = changed || command.stale;
  const title = { prepare: "Prepare proposal", approve: "Approve simulated completion", reject: "Reject proposal", replace: "Replace proposal", review: "Review eligibility", check: "New eligibility check" }[action];
  return <ConfirmDialog title={title} onClose={() => { if (!command.busy) onClose(); }}>
    {action === "check" ? <ReturnForm order={data.order} caseId={data.caseId}/> : <form onSubmit={async event => {
      event.preventDefault(); if (blocked) return; const form = new FormData(event.currentTarget);
      let path = "", payload: object = {};
      if (prepare) { path = action === "replace" ? `/rma-proposals/${proposal!.proposalId}/replace` : "/rma-proposals";
        payload = { ...base, customerMessage: { subject, bodyText: body, locale }, ...(action === "replace" ? { expectedVersion: proposal!.version, note: form.get("note") } : {}) };
      } else if (action === "approve") { path = `/rma-proposals/${proposal!.proposalId}/approve`; payload = { expectedVersion: proposal!.version, confirmation: "approve_and_simulate_completion" }; }
      else if (action === "reject") { path = `/rma-proposals/${proposal!.proposalId}/reject`; payload = { expectedVersion: proposal!.version, reasonCode: form.get("reasonCode"), note: form.get("note") }; }
      else { path = `/eligibility-checks/${check!.eligibilityCheckId}/reviews`; payload = { expectedVersion: data.version, reviewResult: form.get("reviewResult"), reasonCode: form.get("reasonCode"), note: form.get("note") }; }
      await command.run(payload, key => api.write(path, payload, key));
    }}>
      {action === "approve" && proposal && <><p>Confirm this single proposal, version {proposal.version}.</p><dl className="summary"><dt>Quantity</dt><dd>{proposal.requestedQuantity}</dd><dt>Resolution</dt><dd>{label(proposal.resolutionType)}</dd><dt>Amount</dt><dd>{proposal.amountCents === null ? "No cash refund" : money(proposal.amountCents, proposal.currency)}</dd><dt>Replacement SKU</dt><dd>{data.order.items.flatMap(i => i.replacementVariants).find(v => v.id === proposal.replacementVariantId)?.sku ?? "None"}</dd><dt>Return required</dt><dd>{proposal.returnRequired ? "Yes" : "No"}</dd></dl><p>Simulated effects: completed RMA, consumed return quantity, {proposal.resolutionType === "exchange" ? "committed inventory reservation" : proposal.resolutionType === "store_credit" ? "store credit record" : "refund record"}{proposal.returnRequired ? ", return label" : ""}. Customer message remains unsent.</p><label className="checkbox"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} required/>I confirm these simulated effects.</label></>}
      {prepare && <><label>Resolution<select value={choice} onChange={e => { setChoice(e.target.value as typeof choice); setSubject(""); setBody(""); }}>{check?.allowedResolutions.map(option => <option key={option.type} value={option.type}>{label(option.type)}</option>)}</select></label><p>{option?.amountCents != null ? money(option.amountCents, option.currency) : option?.replacementSku} · {option?.returnRequired ? "Return required" : "No return required"}</p><button type="button" disabled={drafting || blocked} onClick={async () => { setDrafting(true); setDraftError(""); try { const draft = await api.write<MessageDraft>("/message-drafts", { ...base, tone: "warm", locale }); if (draft.missingInformation.length) setDraftError(`Missing information: ${draft.missingInformation.join(", ")}`); else { setSubject(draft.subject); setBody(draft.bodyText); } } catch (error) { setDraftError(error instanceof Error ? error.message : "Draft failed"); } finally { setDrafting(false); } }}>Generate message draft</button><label>Message subject<input required maxLength={160} value={subject} onChange={e => setSubject(e.target.value)}/></label><label>Message body (not sent)<textarea required rows={6} maxLength={4000} value={body} onChange={e => setBody(e.target.value)}/></label>{draftError && <p role="alert">{draftError}</p>}{action === "replace" && <div className="untrusted"><h3>Replacement difference</h3><p>Before: {label(proposal!.resolutionType)} · {proposal!.customerMessage.subject}</p><p>{proposal!.customerMessage.bodyText}</p><p>After: {label(choice)} · {subject}</p><p>{body}</p><p>The old proposal will be superseded; the new proposal requires approval.</p></div>}</>}
      {action === "review" && <label>Review decision<select name="reviewResult" required><option value="">Choose a decision</option><option value="eligible_exception_approved">Approve eligibility exception</option><option value="ineligible_exception_denied">Deny eligibility exception</option><option value="insufficient_evidence">Insufficient evidence</option></select></label>}
      {(action === "review" || action === "reject") && <label>Reason code<select name="reasonCode" required><option value="">Choose a reason</option>{["EVIDENCE_VERIFIED", "INSUFFICIENT_EVIDENCE", "CUSTOMER_REQUEST", "POLICY_NOT_SATISFIED", "INCORRECT_RESOLUTION"].map(r => <option key={r} value={r}>{label(r)}</option>)}</select></label>}
      {["review", "reject", "replace"].includes(action) && <label>Reviewer note<textarea name="note" maxLength={1000}/></label>}
      {blocked && <p role="alert" className="error">Facts changed or authorization expired. Your input is preserved. Close and reopen after refreshing; this command is disabled.</p>}
      {command.error && <p role="alert" className="error">{command.error}</p>}
      <button className="primary" disabled={blocked || command.busy || drafting || (action === "approve" && !confirmed) || (prepare && (!subject || !body))}>{command.busy ? "Saving…" : action === "approve" ? "Approve and simulate completion" : action === "prepare" ? "Submit for approval" : title}</button>
    </form>}
  </ConfirmDialog>;
}
