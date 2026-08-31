export type OrderMatchField = "order_number" | "customer_name" | "email";

export interface OrderSummary {
  orderId: string;
  orderNumber: string;
  customerDisplayName: string;
  maskedEmail: string;
  deliveredAt: string | null;
  matchedBy: OrderMatchField;
}

export interface OrderDetails {
  orderId: string;
  orderNumber: string;
  customerDisplayName: string;
  maskedEmail: string;
  currency: string;
  status: string;
  orderedAt: string;
  fulfilledAt: string | null;
  deliveredAt: string | null;
  items: readonly {
    orderItemId: string;
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

export interface InventoryFact {
  variantId: string;
  sku: string;
  active: boolean;
  inventoryQuantity: number;
  inventoryVersion: number;
  unitPriceCents: number;
}

export interface CommerceAdapter {
  searchOrders(sessionId: string, query: string, limit: number): Promise<OrderSummary[]>;
  getOrder(sessionId: string, orderId: string): Promise<OrderDetails>;
  getVariantInventory(sessionId: string, variantId: string): Promise<InventoryFact>;
}
