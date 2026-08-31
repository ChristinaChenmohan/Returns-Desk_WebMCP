import { useState } from "react";
import { PolicyEditor, PolicyActivation } from "../components/PolicyEditor";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../app/providers";
import type { PolicyVersion } from "../api/models";
import { AsyncRegion } from "../components/AsyncRegion";
export function PoliciesPage() {
  const [editing, setEditing] = useState<{ policy: PolicyVersion; clone: boolean } | null>(null); const [activating, setActivating] = useState<PolicyVersion | null>(null); const api = useApi(); const query = useQuery({ queryKey: ["policies"], queryFn: () => api.get<{ items: PolicyVersion[] }>("/policy-versions") });
  return <><div className="page-heading"><div><p className="eyebrow">CONSISTENT, EXPLAINABLE DECISIONS</p><h1>Return policies</h1><p>Historical orders retain their locked policy. Active versions cannot be edited.</p></div></div><AsyncRegion query={query}>{data => <div className="policy-list">{data.items.map(policy => <section className="panel padded" key={policy.id}><div className="section-heading"><h2>{policy.name}</h2><span className="badge">{policy.status}</span></div><p>Version {policy.versionNumber} · {policy.defaultWindowDays}-day window · Maximum {policy.absoluteMaxWindowDays} days</p><p>{policy.defaultReturnRequired ? "Return required" : "Return not required"} · Shipping paid by {policy.returnShippingPayer}</p><details><summary>{policy.rules.length} policy rules</summary>{policy.rules.map(rule => <p key={rule.id}>{rule.explanation}</p>)}</details><div className="actions"><button onClick={() => setEditing({ policy, clone: true })}>Create draft from this version</button>{policy.status === "draft" && <><button onClick={() => setEditing({ policy, clone: false })}>Edit draft</button><button onClick={() => setActivating(policy)}>Validate & activate</button></>}</div></section>)}</div>}</AsyncRegion>{editing && <PolicyEditor {...editing} onClose={() => setEditing(null)}/ >}{activating && <PolicyActivation policy={activating} onClose={() => setActivating(null)}/>}</>;
}

