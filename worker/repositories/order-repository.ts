import type { ConditionCode } from "../../src/shared/contracts/common";
import type { ReplacementVariantFact } from "../domain/policy/types";

interface EligibilityOrderRow {
  order_id: string;
  customer_id: string;
  currency: string;
  ordered_at: string;
  fulfilled_at: string | null;
  delivered_at: string | null;
  order_item_id: string;
  unit_price_cents: number;
  fulfilled_quantity: number;
  previously_returned_quantity: number;
  policy_version_id: string;
  product_id: string;
  category: string;
  final_sale: number;
  returnable_condition: string;
}

interface VariantRow {
  id: string;
  sku: string;
  active: number;
  inventory_quantity: number;
  inventory_version: number;
  price_cents: number;
}

export interface EligibilityOrderFacts {
  orderId: string;
  customerId: string;
  orderItemId: string;
  productId: string;
  currency: string;
  orderedAt: string;
  fulfilledAt: string | null;
  deliveredAt: string | null;
  unitPriceCents: number;
  fulfilledQuantity: number;
  previouslyReturnedQuantity: number;
  policyVersionId: string;
  category: string;
  finalSale: boolean;
  allowedReturnConditions: readonly ConditionCode[];
}

export class OrderRepository {
  constructor(private readonly db: D1Database) {}

  async findEligibilityFacts(
    sessionId: string,
    orderId: string,
    orderItemId: string,
  ): Promise<EligibilityOrderFacts | null> {
    const row = await this.db.prepare(
      `SELECT o.id AS order_id, o.customer_id, o.currency, o.ordered_at,
              o.fulfilled_at, o.delivered_at, oi.id AS order_item_id,
              oi.unit_price_cents, oi.fulfilled_quantity,
              oi.previously_returned_quantity, oi.policy_version_id,
              p.id AS product_id, p.category, p.final_sale,
              p.returnable_condition
         FROM orders o
         JOIN order_items oi
           ON oi.session_id = o.session_id AND oi.order_id = o.id
         JOIN product_variants original_variant
           ON original_variant.session_id = oi.session_id
          AND original_variant.id = oi.variant_id
         JOIN products p
           ON p.session_id = original_variant.session_id
          AND p.id = original_variant.product_id
        WHERE o.session_id = ? AND oi.session_id = ? AND p.session_id = ?
          AND o.id = ? AND oi.id = ?`,
    ).bind(sessionId, sessionId, sessionId, orderId, orderItemId)
      .first<EligibilityOrderRow>();
    if (row === null) return null;
    return {
      orderId: row.order_id,
      customerId: row.customer_id,
      orderItemId: row.order_item_id,
      productId: row.product_id,
      currency: row.currency,
      orderedAt: row.ordered_at,
      fulfilledAt: row.fulfilled_at,
      deliveredAt: row.delivered_at,
      unitPriceCents: row.unit_price_cents,
      fulfilledQuantity: row.fulfilled_quantity,
      previouslyReturnedQuantity: row.previously_returned_quantity,
      policyVersionId: row.policy_version_id,
      category: row.category,
      finalSale: row.final_sale === 1,
      allowedReturnConditions: mapAllowedConditions(row.returnable_condition),
    };
  }

  async findReplacementVariant(
    sessionId: string,
    productId: string,
    variantId: string,
  ): Promise<ReplacementVariantFact | null> {
    const row = await this.db.prepare(
      `SELECT id, sku, active, inventory_quantity, inventory_version, price_cents
         FROM product_variants
        WHERE session_id = ? AND product_id = ? AND id = ?`,
    ).bind(sessionId, productId, variantId).first<VariantRow>();
    return row === null ? null : {
      id: row.id,
      sku: row.sku,
      active: row.active === 1,
      inventoryQuantity: row.inventory_quantity,
      inventoryVersion: row.inventory_version,
      unitPriceCents: row.price_cents,
    };
  }
}

function mapAllowedConditions(value: string): readonly ConditionCode[] {
  if (value === "unopened") return ["unopened"];
  if (value === "unworn" || value === "unused" || value === "opened_unused") {
    return ["unopened", "opened_unused"];
  }
  if (value === "used") return ["unopened", "opened_unused", "used"];
  if (value === "damaged") return ["damaged"];
  return [];
}
