import type { RequestContext } from "../http/context";
import type { Clock } from "./primitives";
import { systemClock } from "./primitives";

interface DashboardRow {
  open_cases: number;
  pending_proposals: number;
  pending_eligibility_reviews: number;
  completed_rmas_today: number;
  exception_count: number;
}

export class DashboardService {
  constructor(private readonly db: D1Database, private readonly clock: Clock = systemClock) {}

  async get(context: RequestContext) {
    const now = this.clock.now().toISOString();
    const today = now.slice(0, 10);
    const row = await this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM return_cases WHERE session_id = ? AND status = 'open') AS open_cases,
        (SELECT COUNT(*) FROM rma_proposals
          WHERE session_id = ? AND status = 'pending' AND expires_at > ?) AS pending_proposals,
        (SELECT COUNT(*) FROM eligibility_checks ec
          WHERE ec.session_id = ? AND ec.status = 'needs_review' AND ec.expires_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM eligibility_checks child
               WHERE child.session_id = ec.session_id AND child.parent_check_id = ec.id
            )) AS pending_eligibility_reviews,
        (SELECT COUNT(*) FROM rmas
          WHERE session_id = ? AND status = 'completed' AND substr(completed_at, 1, 10) = ?) AS completed_rmas_today,
        ((SELECT COUNT(*) FROM eligibility_checks ec
           WHERE ec.session_id = ? AND ec.status = 'needs_review' AND ec.expires_at > ?
             AND NOT EXISTS (
               SELECT 1 FROM eligibility_checks child
                WHERE child.session_id = ec.session_id AND child.parent_check_id = ec.id
             ))
         + (SELECT COUNT(*) FROM rma_proposals
             WHERE session_id = ? AND status = 'invalidated')) AS exception_count`,
    ).bind(
      context.sessionId, context.sessionId, now,
      context.sessionId, now, context.sessionId, today, context.sessionId, now, context.sessionId,
    ).first<DashboardRow>();
    const safe = row ?? {
      open_cases: 0, pending_proposals: 0, pending_eligibility_reviews: 0,
      completed_rmas_today: 0, exception_count: 0,
    };
    return {
      openCases: safe.open_cases,
      pendingProposals: safe.pending_proposals,
      pendingEligibilityReviews: safe.pending_eligibility_reviews,
      completedRmasToday: safe.completed_rmas_today,
      exceptionCount: safe.exception_count,
    };
  }
}
