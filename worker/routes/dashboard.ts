import { DashboardService } from "../domain/dashboard-service";
import { ApprovalQueueService } from "../domain/approval-queue-service";
import { z } from "zod";
import { pageSchema, parse, query, type RouteKit } from "./shared";
export function dashboardRoutes(k: RouteKit) {
  k.get("/dashboard", "dashboard.read", async c => k.ok(c, await new DashboardService(k.db, k.clock).get(c.get("requestContext"))));
  k.get("/approval-queue", "approvals.read.human", async c => k.ok(c, await new ApprovalQueueService(k.db, k.clock).list(
    parse(pageSchema.extend({ type: z.enum(["rma_proposal", "eligibility_review"]).optional() }), query(c)) as Parameters<ApprovalQueueService["list"]>[0], c.get("requestContext"))));
}
