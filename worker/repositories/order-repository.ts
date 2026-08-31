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

interface OrderSearchRow {
  id: string;
  order_number: string;
  customer_name: string;
  email_normalized: string;
  delivered_at: string | null;
  matched_by: "order_number" | "customer_name" | "email";
}

interface OrderDetailRow {
  id: string;
  order_number: string;
  customer_name: string;
  email_normalized: string;
  currency: string;
  status: string;
  ordered_at: string;
  fulfilled_at: string | null;
  delivered_at: string | null;
}

interface OrderItemDetailRow {
  id: string;
  variant_id: string;
  sku: string;
  product_title: string;
  variant_title: string;
  quantity: number;
  unit_price_cents: number;
  fulfilled_quantity: number;
  previously_returned_quantity: number;
  policy_version_id: string;
}

export interface RepositoryOrderSummary {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  deliveredAt: string | null;
  matchedBy: OrderSearchRow["matched_by"];
}

export interface RepositoryOrderDetails {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  currency: string;
  status: string;
  orderedAt: string;
  fulfilledAt: string | null;
  deliveredAt: string | null;
  items: readonly {
    id: string;
    variantId: string;
    sku: string;
    productTitle: string;
    variantTitle: string;
    quantity: number;
    unitPriceCents: number;
    fulfilledQuantity: number;
    previouslyReturnedQuantity: number;
    policyVersionId: string;
  }[];
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

  async search(sessionId: string, query: string, limit: number): Promise<RepositoryOrderSummary[]> {
    const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const pattern = `%${escaped.toLowerCase()}%`;
    const rows = await this.db.prepare(
      `SELECT o.id, o.order_number, c.name AS customer_name,
              c.email_normalized, o.delivered_at,
              CASE
                WHEN lower(o.order_number) LIKE ? ESCAPE '\\' THEN 'order_number'
                WHEN lower(c.name) LIKE ? ESCAPE '\\' THEN 'customer_name'
                ELSE 'email'
              END AS matched_by
         FROM orders o
         JOIN customers c ON c.session_id = o.session_id AND c.id = o.customer_id
        WHERE o.session_id = ? AND c.session_id = ?
          AND (lower(o.order_number) LIKE ? ESCAPE '\\'
            OR lower(c.name) LIKE ? ESCAPE '\\'
            OR lower(c.email_normalized) LIKE ? ESCAPE '\\')
        ORDER BY o.order_number, o.id
        LIMIT ?`,
    ).bind(pattern, pattern, sessionId, sessionId, pattern, pattern, pattern, limit)
      .all<OrderSearchRow>();
    return rows.results.map(row => ({
      id: row.id,
      orderNumber: row.order_number,
      customerName: row.customer_name,
      customerEmail: row.email_normalized,
      deliveredAt: row.delivered_at,
      matchedBy: row.matched_by,
    }));
  }

  async findDetails(sessionId: string, orderId: string): Promise<RepositoryOrderDetails | null> {
    const order = await this.db.prepare(
      `SELECT o.id, o.order_number, c.name AS customer_name, c.email_normalized,
              o.currency, o.status, o.ordered_at, o.fulfilled_at, o.delivered_at
         FROM orders o
         JOIN customers c ON c.session_id = o.session_id AND c.id = o.customer_id
        WHERE o.session_id = ? AND c.session_id = ? AND o.id = ?`,
    ).bind(sessionId, sessionId, orderId).first<OrderDetailRow>();
    if (order === null) return null;
    const items = await this.db.prepare(
      `SELECT oi.id, oi.variant_id, pv.sku, p.title AS product_title,
              pv.title AS variant_title, oi.quantity, oi.unit_price_cents,
              oi.fulfilled_quantity, oi.previously_returned_quantity,
              oi.policy_version_id
         FROM order_items oi
         JOIN product_variants pv
           ON pv.session_id = oi.session_id AND pv.id = oi.variant_id
         JOIN products p ON p.session_id = pv.session_id AND p.id = pv.product_id
        WHERE oi.session_id = ? AND pv.session_id = ? AND p.session_id = ?
          AND oi.order_id = ?
        ORDER BY oi.id`,
    ).bind(sessionId, sessionId, sessionId, orderId).all<OrderItemDetailRow>();
    return {
      id: order.id,
      orderNumber: order.order_number,
      customerName: order.customer_name,
      customerEmail: order.email_normalized,
      currency: order.currency,
      status: order.status,
      orderedAt: order.ordered_at,
      fulfilledAt: order.fulfilled_at,
      deliveredAt: order.delivered_at,
      items: items.results.map(item => ({
        id: item.id,
        variantId: item.variant_id,
        sku: item.sku,
        productTitle: item.product_title,
        variantTitle: item.variant_title,
        quantity: item.quantity,
        unitPriceCents: item.unit_price_cents,
        fulfilledQuantity: item.fulfilled_quantity,
        previouslyReturnedQuantity: item.previously_returned_quantity,
        policyVersionId: item.policy_version_id,
      })),
    };
  }

  async findVariantInventory(sessionId: string, variantId: string): Promise<ReplacementVariantFact | null> {
    const row = await this.db.prepare(
      `SELECT id, sku, active, inventory_quantity, inventory_version, price_cents
         FROM product_variants
        WHERE session_id = ? AND id = ?`,
    ).bind(sessionId, variantId).first<VariantRow>();
    return row === null ? null : toVariant(row);
  }

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
    return row === null ? null : toVariant(row);
  }
}

function toVariant(row: VariantRow): ReplacementVariantFact {
  return {
    id: row.id,
    sku: row.sku,
    active: row.active === 1,
    inventoryQuantity: row.inventory_quantity,
    inventoryVersion: row.inventory_version,
    unitPriceCents: row.price_cents,
  };
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
