import type { ResolutionType } from "../../src/shared/contracts/common";
import type { GetReturnPolicyInput } from "../../src/shared/contracts/tools";
import type { RequestContext } from "../http/context";
import { OrderRepository } from "../repositories/order-repository";
import { PolicyRepository } from "../repositories/policy-repository";
import { DomainError } from "./errors";
import type { ReturnShippingPayer } from "./policy/types";

export interface LockedPolicyResult {
  policyVersionId: string;
  name: string;
  lockedToOrderItem: true;
  defaultWindowDays: number;
  absoluteMaxWindowDays: number;
  defaultReturnRequired: boolean;
  returnShippingPayer: ReturnShippingPayer;
  supportedResolutions: readonly ResolutionType[];
  ruleSummary: readonly string[];
}

export class PolicyReadService {
  private readonly orders: OrderRepository;
  private readonly policies: PolicyRepository;

  constructor(db: D1Database) {
    this.orders = new OrderRepository(db);
    this.policies = new PolicyRepository(db);
  }

  async getLockedPolicy(input: GetReturnPolicyInput, context: RequestContext): Promise<LockedPolicyResult> {
    const facts = await this.orders.findEligibilityFacts(context.sessionId, input.orderId, input.orderItemId);
    if (facts === null) {
      throw new DomainError("ORDER_ITEM_NOT_FOUND", 404, false, "select_an_order_item");
    }
    const policy = await this.policies.findById(context.sessionId, facts.policyVersionId);
    if (policy === null) {
      throw new DomainError("POLICY_VERSION_NOT_FOUND", 404, false, "reload_order");
    }
    return {
      policyVersionId: policy.id,
      name: policy.name,
      lockedToOrderItem: true,
      defaultWindowDays: policy.defaultWindowDays,
      absoluteMaxWindowDays: policy.absoluteMaxWindowDays,
      defaultReturnRequired: policy.defaultReturnRequired,
      returnShippingPayer: policy.returnShippingPayer,
      supportedResolutions: [...policy.defaultResolutions],
      ruleSummary: policy.rules.filter(rule => rule.active).map(rule => rule.explanation),
    };
  }
}
