import type { CommerceAdapter, InventoryFact, OrderDetails, OrderSummary } from "../domain/commerce-adapter";
import { DomainError } from "../domain/errors";
import { OrderRepository } from "../repositories/order-repository";

export class DemoCommerceAdapter implements CommerceAdapter {
  private readonly orders: OrderRepository;

  constructor(private readonly db: D1Database) {
    this.orders = new OrderRepository(db);
  }

  async searchOrders(sessionId: string, query: string, limit: number): Promise<OrderSummary[]> {
    return (await this.orders.search(sessionId, query, limit)).map(order => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerDisplayName: maskName(order.customerName),
      maskedEmail: maskEmail(order.customerEmail),
      deliveredAt: order.deliveredAt,
      matchedBy: order.matchedBy,
    }));
  }

  async getOrder(sessionId: string, orderId: string): Promise<OrderDetails> {
    const order = await this.orders.findDetails(sessionId, orderId);
    if (order === null) throw new DomainError("ORDER_NOT_FOUND", 404, false, "search_orders");
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerDisplayName: maskName(order.customerName),
      maskedEmail: maskEmail(order.customerEmail),
      currency: order.currency,
      status: order.status,
      orderedAt: order.orderedAt,
      fulfilledAt: order.fulfilledAt,
      deliveredAt: order.deliveredAt,
      items: await Promise.all(order.items.map(async item => ({
        orderItemId: item.id,
        variantId: item.variantId,
        sku: item.sku,
        productTitle: item.productTitle,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        fulfilledQuantity: item.fulfilledQuantity,
        previouslyReturnedQuantity: item.previouslyReturnedQuantity,
        remainingReturnableQuantity: item.fulfilledQuantity - item.previouslyReturnedQuantity,
        replacementVariants: (await this.db.prepare(`SELECT v.id, v.sku, v.title, v.inventory_quantity AS inventoryQuantity
          FROM product_variants v JOIN product_variants original ON original.session_id = v.session_id AND original.product_id = v.product_id
          WHERE v.session_id = ? AND original.id = ? AND v.id <> original.id AND v.active = 1 ORDER BY v.sku`)
          .bind(sessionId, item.variantId).all<{ id: string; sku: string; title: string; inventoryQuantity: number }>()).results,
        policyVersionId: item.policyVersionId,
      }))),
    };
  }

  async getVariantInventory(sessionId: string, variantId: string): Promise<InventoryFact> {
    const variant = await this.orders.findVariantInventory(sessionId, variantId);
    if (variant === null) throw new DomainError("VARIANT_NOT_FOUND", 404, false, "select_a_variant");
    return {
      variantId: variant.id,
      sku: variant.sku,
      active: variant.active,
      inventoryQuantity: variant.inventoryQuantity,
      inventoryVersion: variant.inventoryVersion,
      unitPriceCents: variant.unitPriceCents,
    };
  }
}

function maskName(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const first = parts[0];
  if (first === undefined) return "Customer";
  const last = parts.at(-1);
  return last === undefined || last === first ? `${first.slice(0, 1)}.` : `${first} ${last.slice(0, 1)}.`;
}

function maskEmail(email: string): string {
  const separator = email.lastIndexOf("@");
  if (separator <= 0) return "***";
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  return `${local.slice(0, 1)}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
}
