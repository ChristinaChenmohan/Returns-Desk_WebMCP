import { useState } from "react";
import { ResetDemoDialog } from "./ResetDemoDialog";
import { NavLink, Outlet } from "react-router";
import { useApi } from "../app/providers";
export function AppShell() {
  const api = useApi(); const [reset, setReset] = useState(false);
  return <div className="app-shell"><a className="skip" href="#main">Skip to content</a><aside className="sidebar"><NavLink to="/" className="brand"><span className="brand-mark">↩</span> Returns Desk</NavLink><p className="sidebar-caption">CUSTOMER OPERATIONS</p><nav aria-label="Main navigation">{[["/", "Dashboard", "◫"], ["/orders", "Orders", "▤"], ["/approvals", "Approval Queue", "✓"], ["/policies", "Policies", "≋"]].map(([to, name, icon]) => <NavLink key={to} to={to!} end={to === "/"}><span aria-hidden="true">{icon}</span>{name}</NavLink>)}</nav><div className="sidebar-bottom"><span className="status-dot"/> Private demo session<p>Seed {api.seedVersion} · isolated data</p><p>Every refund, label and inventory change is simulated.</p><button onClick={() => setReset(true)}>Reset demo</button></div></aside><div className="main-shell"><header className="topbar"><span>Merchant workspace</span><div><span className="demo-badge">DEMO</span><span className="avatar">AC</span></div></header><div className="demo-notice">A safe space to resolve returns. No real payments, emails or shipments.</div><main id="main"><Outlet />{reset && <ResetDemoDialog onClose={() => setReset(false)}/>}</main></div></div>;
}

