import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useApi } from "../app/providers";
import type { Dashboard, CaseList } from "../api/models";
import { AsyncRegion } from "../components/AsyncRegion";

const statMeta = [["Open cases", "case", "/orders", "▢"], ["Awaiting approval", "approval", "/approvals", "◷"], ["Eligibility reviews", "review", "/approvals", "♙"], ["Completed today", "done", "/approvals", "✓"]] as const;

export function DashboardPage() {
  const api = useApi();
  const summary = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Dashboard>("/dashboard") });
  const cases = useQuery({ queryKey: ["cases"], queryFn: () => api.get<CaseList>("/cases") });
  return <>
    <section className="hero dashboard-hero"><div className="hero-copy"><p className="greeting">Your returns workspace <span aria-hidden="true">✦</span></p><h1>Good returns. Better resolutions.</h1><p>One workspace for clear decisions and thoughtful customer care.</p></div><img src="/assets/returns-hero.webp" alt="" className="hero-art"/><Link className="button primary hero-action" to="/orders">Find an order <span aria-hidden="true">⌕</span></Link></section>
    <p className="section-kicker">YOUR DAILY OVERVIEW</p>
    <AsyncRegion query={summary}>{data => <div className="stats">{statMeta.map(([title, tone, to, icon], index) => { const value = [data.openCases, data.pendingProposals, data.pendingEligibilityReviews, data.completedRmasToday][index]; return <Link key={title} to={to} className={`stat stat-${tone}`}><span className="stat-icon" aria-hidden="true">{icon}</span><span className="stat-copy"><span>{title}</span><strong>{value}</strong><small>Current demo session ↗</small></span></Link>; })}</div>}</AsyncRegion>
    <div className="section-heading"><h2>Recent return cases</h2><Link to="/approvals">View approval queue <span aria-hidden="true">→</span></Link></div>
    <AsyncRegion query={cases}>{data => <section className="panel recent-panel">{data.items.length ? <table><thead><tr><th>Order</th><th>Customer</th><th>Reason</th><th>Status</th><th /></tr></thead><tbody>{data.items.map(item => <tr key={item.caseId}><td>{item.orderNumber}</td><td>{item.customerDisplayName}</td><td>{item.reasonCode.replaceAll("_", " ")}</td><td><span className="badge">{item.status}</span></td><td><Link to={`/cases/${item.caseId}`}>Open case →</Link></td></tr>)}</tbody></table> : <div className="empty illustrated-empty"><img src="/assets/returns-hero.webp" alt=""/><h3>A fresh start for every return.</h3><p>Search ORD-1001 to try a return, or ORD-1002 to explore policy exceptions.</p><Link to="/orders" className="button">Explore demo orders</Link></div>}</section>}</AsyncRegion>
    <section className="guidance"><span className="guidance-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2zm16 0a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2zm0 2c0 3-2 4-5 4"/></svg></span><div><p className="eyebrow">BUILT FOR HUMAN JUDGMENT</p><h2>Helpful agents. You make the final call.</h2><p>Agents can gather facts and prepare proposals. Only you can approve a simulated RMA.</p></div><span className="guidance-symbol" aria-hidden="true">✓</span></section>
  </>;
}
