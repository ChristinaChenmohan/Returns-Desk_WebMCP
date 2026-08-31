import { BrowserRouter, Routes, Route, Link } from "react-router";
import { AppShell } from "../components/AppShell";
import { DashboardPage } from "../pages/DashboardPage";
import { OrdersPage } from "../pages/OrdersPage";
import { CasePage } from "../pages/CasePage";
import { ApprovalQueuePage } from "../pages/ApprovalQueuePage";
import { PoliciesPage } from "../pages/PoliciesPage";
export function Router() { return <BrowserRouter><Routes><Route element={<AppShell/>}><Route index element={<DashboardPage/>}/><Route path="orders" element={<OrdersPage/>}/><Route path="cases/:caseId" element={<CasePage/>}/><Route path="approvals" element={<ApprovalQueuePage/>}/><Route path="policies" element={<PoliciesPage/>}/><Route path="*" element={<><h1>Page not found</h1><Link to="/">Return to Dashboard</Link></>}/></Route></Routes></BrowserRouter>; }
