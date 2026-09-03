import { useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router";
import { useApi } from "../app/providers";
import { ResetDemoDialog } from "./ResetDemoDialog";

const navItems: Array<[string, string, ReactNode]> = [
  ["/", "Dashboard", <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>],
  ["/orders", "Orders", <><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></>],
  ["/approvals", "Approval Queue", <path d="m5 12 4 4L19 6"/>],
  ["/policies", "Policies", <><path d="M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6z"/><path d="m9 12 2 2 4-5"/></>],
];

function LineIcon({ children }: { children: ReactNode }) {
  return <svg className="line-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

export function AppShell() {
  const api = useApi();
  const [reset, setReset] = useState(false);
  const [notice, setNotice] = useState(true);
  return <div className="app-shell">
    <a className="skip" href="#main">Skip to content</a>
    <aside className="sidebar">
      <NavLink to="/" className="brand"><span className="brand-mark" aria-hidden="true">↩</span><span>Returns Desk</span></NavLink>
      <p className="sidebar-caption">CUSTOMER OPERATIONS</p>
      <nav aria-label="Main navigation">{navItems.map(([to, name, icon]) => <NavLink key={to} to={to} end={to === "/"}><LineIcon>{icon}</LineIcon><span>{name}</span></NavLink>)}</nav>
      <div className="sidebar-landscape" aria-hidden="true"><i/><i/><i/></div>
      <div className="sidebar-bottom"><strong><span className="session-lock" aria-hidden="true"/> Private demo session</strong><p>Seed {api.seedVersion} · isolated data</p><p>Every refund, label and inventory change is simulated.</p><button onClick={() => setReset(true)}>Reset demo</button></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><strong>Merchant workspace</strong><div><span className="demo-badge">DEMO</span><span className="avatar">AC</span></div></header>
      {notice && <div className="demo-notice"><span className="notice-shield" aria-hidden="true">♢</span><span>A safe space to resolve returns. No real payments, emails or shipments.</span><button className="notice-close" aria-label="Dismiss demo notice" onClick={() => setNotice(false)}>×</button></div>}
      <main id="main"><Outlet />{reset && <ResetDemoDialog onClose={() => setReset(false)}/>}</main>
    </div>
  </div>;
}
