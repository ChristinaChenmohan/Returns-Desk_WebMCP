import { useState } from "react";
import { PolicyEditor, PolicyActivation } from "../components/PolicyEditor";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../app/providers";
import type { PolicyVersion } from "../api/models";
import { AsyncRegion } from "../components/AsyncRegion";
export function PoliciesPage() {
  const [editing, setEditing] = useState<{ policy: PolicyVersion; clone: boolean } | null>(null); const [activating, setActivating] = useState<PolicyVersion | null>(null); const api = useApi(); const query = useQuery({ queryKey: ["policies"], queryFn: () => api.get<{ items: PolicyVersion[] }>("/policy-versions") });
  return <>
    <section className="page-hero policy-hero"><div className="hero-copy"><p className="eyebrow">CONSISTENT, EXPLAINABLE DECISIONS</p><h1>Return policies</h1><p>Historical orders retain their locked policy. Active versions cannot be edited.</p></div><img src="/assets/returns-hero.webp" alt="" className="page-hero-art"/></section>
    <AsyncRegion query={query}>{data => <div className="policy-list">{data.items.map(policy => <section className="panel policy-card" key={policy.id}><div className="section-heading"><h2>{policy.name}</h2><span className="badge">{policy.status}</span></div><div className="policy-meta"><span><i aria-hidden="true">▣</i> &nbsp; Version {policy.versionNumber}</span><span><i aria-hidden="true">◷</i> &nbsp; {policy.defaultWindowDays}-day window</span><span><i aria-hidden="true">▦</i> &nbsp; Maximum {policy.absoluteMaxWindowDays} days</span></div><div className="policy-meta"><span><i aria-hidden="true">▧</i> &nbsp; {policy.defaultReturnRequired ? "Return required" : "Return not required"}</span><span>Shipping paid by {policy.returnShippingPayer}</span></div><details className="policy-rules"><summary>{policy.rules.length} policy rules</summary><div className="rule-preview">{policy.rules.slice(0, 2).map((rule, index) => <p key={rule.id}><span className={`rule-icon rule-${index}`}>{index + 1}</span>{rule.explanation}</p>)}</div>{policy.rules.slice(2).map(rule => <p key={rule.id}>{rule.explanation}</p>)}</details><div className="actions"><button className="primary" onClick={() => setEditing({ policy, clone: true })}><span aria-hidden="true">▤</span> Create draft from this version</button>{policy.status === "draft" && <><button onClick={() => setEditing({ policy, clone: false })}>Edit draft</button><button onClick={() => setActivating(policy)}>Validate & activate</button></>}</div></section>)}</div>}</AsyncRegion>
    {editing && <PolicyEditor {...editing} onClose={() => setEditing(null)}/ >}{activating && <PolicyActivation policy={activating} onClose={() => setActivating(null)}/>}
  </>;
}

