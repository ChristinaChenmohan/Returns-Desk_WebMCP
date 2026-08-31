import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useApi } from "../app/providers";
import { label, type Queue } from "../api/models";
import { AsyncRegion } from "../components/AsyncRegion";
export function ApprovalQueuePage() {
  const api = useApi(); const [type, setType] = useState("rma_proposal");
  const query = useQuery({ queryKey: ["queue", type], queryFn: () => api.get<Queue>(`/approval-queue?type=${type}`), refetchInterval: 15_000 });
  return <><div className="page-heading"><div><p className="eyebrow">A HUMAN DECISION, EVERY TIME</p><h1>Approval queue</h1><p>Review each case individually. Nothing is approved in bulk.</p></div></div><div className="tabs" role="group" aria-label="Queue type">{[["rma_proposal", "RMA proposals"], ["eligibility_review", "Eligibility reviews"]].map(([value, name]) => <button key={value} aria-pressed={type === value} onClick={() => setType(value!)}>{name}</button>)}</div><AsyncRegion query={query}>{data => <section className="panel">{data.items.length ? data.items.map(item => <Link className="queue-row" key={item.id} to={`/cases/${item.caseId}`}><div><strong>{item.orderNumber}</strong><p>{item.customerDisplayName}</p></div><span>{label(item.status)}</span><span>{item.resolutionType ? label(item.resolutionType) : "Human review required"}</span><span>Review case →</span></Link>) : <div className="empty"><h2>All clear for now.</h2><p>New proposals and eligibility reviews will appear here.</p><Link to="/orders">Find an order →</Link></div>}</section>}</AsyncRegion></>;
}
