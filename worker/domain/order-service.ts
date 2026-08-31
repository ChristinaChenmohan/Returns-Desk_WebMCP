import type { SearchOrdersInput } from "../../src/shared/contracts/tools";
import type { RequestContext } from "../http/context";
import type { CommerceAdapter, OrderDetails, OrderSummary } from "./commerce-adapter";
import { DomainError } from "./errors";

export interface OrderSearchResult {
  orders: readonly OrderSummary[];
  resultCount: number;
  requiresSelection: boolean;
}

export class OrderService {
  constructor(private readonly commerce: CommerceAdapter) {}

  async search(input: SearchOrdersInput, context: RequestContext): Promise<OrderSearchResult> {
    const query = input.query.trim();
    if (query.length < 2 || query.length > 120) {
      throw new DomainError("INVALID_SEARCH_QUERY", 400, false, "correct_input");
    }
    const limit = Math.min(5, Math.max(1, Math.trunc(input.limit)));
    const orders = await this.commerce.searchOrders(context.sessionId, query, limit);
    return { orders, resultCount: orders.length, requiresSelection: orders.length > 1 };
  }

  get(orderId: string, context: RequestContext): Promise<OrderDetails> {
    return this.commerce.getOrder(context.sessionId, orderId);
  }
}
