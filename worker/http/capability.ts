import { createMiddleware } from "hono/factory";

import { DomainError } from "../domain/errors";
import type { AppEnvironment } from "./context";

export const CAPABILITY = {
  SESSION_READ: "session.read",
  DASHBOARD_READ: "dashboard.read",
  ORDERS_SEARCH: "orders.search",
  ORDERS_READ: "orders.read",
  POLICY_READ: "policy.read",
  CASES_READ: "cases.read",
  AUDIT_READ: "audit.read",
  PROPOSALS_READ: "proposals.read",
  ELIGIBILITY_CHECK: "eligibility.check",
  RESOLUTIONS_COMPARE: "resolutions.compare",
  MESSAGES_DRAFT: "messages.draft",
  PROPOSAL_SUBMIT: "proposal.submit",
  CASES_CREATE: "cases.create",
  APPROVALS_READ_HUMAN: "approvals.read.human",
  ELIGIBILITY_REVIEW_HUMAN: "eligibility.review.human",
  PROPOSAL_APPROVE_HUMAN: "proposal.approve.human",
  PROPOSAL_REJECT_HUMAN: "proposal.reject.human",
  PROPOSAL_REPLACE_HUMAN: "proposal.replace.human",
  DEMO_RESET_HUMAN: "demo.reset.human",
  POLICY_WRITE_HUMAN: "policy.write.human",
  POLICY_ACTIVATE_HUMAN: "policy.activate.human",
  AGENT_TOOL_CHANNEL: "tools.channel.agent",
} as const;

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];
export type ChannelClass = "human" | "agent";

const SHARED_CAPABILITIES: Capability[] = [
  CAPABILITY.SESSION_READ,
  CAPABILITY.ORDERS_SEARCH,
  CAPABILITY.POLICY_READ,
  CAPABILITY.ELIGIBILITY_CHECK,
  CAPABILITY.RESOLUTIONS_COMPARE,
  CAPABILITY.MESSAGES_DRAFT,
  CAPABILITY.PROPOSAL_SUBMIT,
];

const HUMAN_CAPABILITIES: ReadonlySet<Capability> = new Set([
  ...SHARED_CAPABILITIES,
  CAPABILITY.DASHBOARD_READ,
  CAPABILITY.ORDERS_READ,
  CAPABILITY.CASES_READ,
  CAPABILITY.AUDIT_READ,
  CAPABILITY.PROPOSALS_READ,
  CAPABILITY.CASES_CREATE,
  CAPABILITY.APPROVALS_READ_HUMAN,
  CAPABILITY.ELIGIBILITY_REVIEW_HUMAN,
  CAPABILITY.PROPOSAL_APPROVE_HUMAN,
  CAPABILITY.PROPOSAL_REJECT_HUMAN,
  CAPABILITY.PROPOSAL_REPLACE_HUMAN,
  CAPABILITY.DEMO_RESET_HUMAN,
  CAPABILITY.POLICY_WRITE_HUMAN,
  CAPABILITY.POLICY_ACTIVATE_HUMAN,
]);

const AGENT_CAPABILITIES: ReadonlySet<Capability> = new Set([
  ...SHARED_CAPABILITIES,
  CAPABILITY.AGENT_TOOL_CHANNEL,
]);

export function capabilitiesForChannel(channel: ChannelClass): ReadonlySet<Capability> {
  return channel === "human" ? HUMAN_CAPABILITIES : AGENT_CAPABILITIES;
}

export function requireCapability(required: Capability) {
  return createMiddleware<AppEnvironment>(async (c, next) => {
    if (!c.get("capabilities").has(required)) {
      throw new DomainError("FORBIDDEN", 403, false);
    }
    await next();
  });
}
