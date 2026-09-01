import type { Clock, IdGenerator } from "../domain/primitives";
import { cryptoIds, systemClock } from "../domain/primitives";

type D1Value = ArrayBuffer | null | number | string;

export interface SeedGuard {
  commandKind: string;
  idempotencyKey: string;
  requestHash: string;
  resultEntityId: string;
}

interface DemoIds {
  customer: string;
  shoe: string;
  mug: string;
  shoeBlueEight: string;
  shoeBlueNine: string;
  mugLimited: string;
  policy: string;
  finalSaleRule: string;
  footwearRule: string;
  recentOrder: string;
  oldOrder: string;
  recentItem: string;
  oldItem: string;
}

export function buildSeedStatements(
  db: D1Database,
  sessionId: string,
  clock: Clock = systemClock,
  ids: IdGenerator = cryptoIds,
  guard?: SeedGuard,
): D1PreparedStatement[] {
  const demoIds = createDemoIds(ids);
  const now = clock.now();
  const recentOrderedAt = daysBefore(now, 16);
  const recentFulfilledAt = daysBefore(now, 14);
  const recentDeliveredAt = daysBefore(now, 10);
  // Keep the final-sale exception fixture inside the return window so its
  // damaged condition reaches the explicit human-review rule.
  const oldOrderedAt = daysBefore(now, 9);
  const oldFulfilledAt = daysBefore(now, 8);
  const oldDeliveredAt = daysBefore(now, 7);

  return [
    prepareInsert(
      db,
      "customers",
      ["id", "session_id", "name", "email_normalized", "locale"],
      [demoIds.customer, sessionId, "Avery Chen", "avery@example.test", "en-US"],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "products",
      ["id", "session_id", "title", "category", "final_sale", "returnable_condition"],
      [demoIds.shoe, sessionId, "Everyday Runner", "footwear", 0, "unworn"],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "products",
      ["id", "session_id", "title", "category", "final_sale", "returnable_condition"],
      [demoIds.mug, sessionId, "Limited Studio Mug", "home", 1, "damaged"],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "product_variants",
      [
        "id", "session_id", "product_id", "sku", "title", "option_values_json",
        "price_cents", "inventory_quantity", "inventory_version", "active",
      ],
      [
        demoIds.shoeBlueEight, sessionId, demoIds.shoe, "SHOE-BLUE-8", "Blue / 8",
        '{"color":"blue","size":"8"}', 12900, 2, 1, 1,
      ],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "product_variants",
      [
        "id", "session_id", "product_id", "sku", "title", "option_values_json",
        "price_cents", "inventory_quantity", "inventory_version", "active",
      ],
      [
        demoIds.shoeBlueNine, sessionId, demoIds.shoe, "SHOE-BLUE-9", "Blue / 9",
        '{"color":"blue","size":"9"}', 12900, 4, 1, 1,
      ],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "product_variants",
      [
        "id", "session_id", "product_id", "sku", "title", "option_values_json",
        "price_cents", "inventory_quantity", "inventory_version", "active",
      ],
      [
        demoIds.mugLimited, sessionId, demoIds.mug, "MUG-LIMITED", "Stoneware",
        '{"finish":"stoneware"}', 3200, 12, 1, 1,
      ],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "policy_versions",
      [
        "id", "session_id", "version_number", "name", "effective_from", "effective_to",
        "default_window_days", "absolute_max_window_days", "default_return_required",
        "default_resolutions_json", "return_shipping_payer", "status", "version",
      ],
      [
        demoIds.policy, sessionId, 1, "Demo Returns Policy", daysBefore(now, 365), null,
        30, 60, 1, '["exchange","refund","store_credit"]', "merchant", "active", 1,
      ],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "policy_rules",
      [
        "id", "session_id", "policy_version_id", "rule_type", "priority",
        "conditions_json", "outcome_json", "explanation_template", "active",
      ],
      [
        demoIds.finalSaleRule, sessionId, demoIds.policy, "final_sale", 300,
        '{"finalSale":true}', '{"eligibility":"ineligible","reasonCode":"FINAL_SALE"}',
        "Final-sale items cannot be returned.", 1,
      ],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "policy_rules",
      [
        "id", "session_id", "policy_version_id", "rule_type", "priority",
        "conditions_json", "outcome_json", "explanation_template", "active",
      ],
      [
        demoIds.footwearRule, sessionId, demoIds.policy, "category_window", 200,
        '{"category":"footwear"}', '{"returnWindowDays":30}',
        "Footwear may be returned within 30 days of delivery.", 1,
      ],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "orders",
      [
        "id", "session_id", "order_number", "customer_id", "currency", "status",
        "ordered_at", "fulfilled_at", "delivered_at",
      ],
      [
        demoIds.recentOrder, sessionId, "ORD-1001", demoIds.customer, "USD", "delivered",
        recentOrderedAt, recentFulfilledAt, recentDeliveredAt,
      ],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "orders",
      [
        "id", "session_id", "order_number", "customer_id", "currency", "status",
        "ordered_at", "fulfilled_at", "delivered_at",
      ],
      [
        demoIds.oldOrder, sessionId, "ORD-1002", demoIds.customer, "USD", "delivered",
        oldOrderedAt, oldFulfilledAt, oldDeliveredAt,
      ],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "order_items",
      [
        "id", "session_id", "order_id", "variant_id", "quantity", "unit_price_cents",
        "fulfilled_quantity", "previously_returned_quantity", "policy_version_id",
      ],
      [
        demoIds.recentItem, sessionId, demoIds.recentOrder, demoIds.shoeBlueEight, 1,
        12900, 1, 0, demoIds.policy,
      ],
      sessionId,
      guard,
    ),
    prepareInsert(
      db,
      "order_items",
      [
        "id", "session_id", "order_id", "variant_id", "quantity", "unit_price_cents",
        "fulfilled_quantity", "previously_returned_quantity", "policy_version_id",
      ],
      [
        demoIds.oldItem, sessionId, demoIds.oldOrder, demoIds.mugLimited, 1,
        3200, 1, 0, demoIds.policy,
      ],
      sessionId,
      guard,
    ),
  ];
}

export async function seedDemoSession(
  db: D1Database,
  sessionId: string,
  clock: Clock = systemClock,
  ids: IdGenerator = cryptoIds,
): Promise<void> {
  await db.batch(buildSeedStatements(db, sessionId, clock, ids));
}

function createDemoIds(ids: IdGenerator): DemoIds {
  return {
    customer: ids.next("customer"),
    shoe: ids.next("product"),
    mug: ids.next("product"),
    shoeBlueEight: ids.next("variant"),
    shoeBlueNine: ids.next("variant"),
    mugLimited: ids.next("variant"),
    policy: ids.next("policy"),
    finalSaleRule: ids.next("policy_rule"),
    footwearRule: ids.next("policy_rule"),
    recentOrder: ids.next("order"),
    oldOrder: ids.next("order"),
    recentItem: ids.next("order_item"),
    oldItem: ids.next("order_item"),
  };
}

function daysBefore(date: Date, days: number): string {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function prepareInsert(
  db: D1Database,
  table: string,
  columns: readonly string[],
  values: readonly D1Value[],
  sessionId: string,
  guard?: SeedGuard,
): D1PreparedStatement {
  const placeholders = values.map(() => "?").join(", ");
  if (guard === undefined) {
    return db
      .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`)
      .bind(...values);
  }

  return db
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")})
       SELECT ${placeholders}
        WHERE EXISTS (
          SELECT 1
            FROM idempotency_records
           WHERE session_id = ? AND command_kind = ?
             AND idempotency_key = ? AND request_hash = ?
             AND result_entity_id = ?
        )`,
    )
    .bind(
      ...values,
      sessionId,
      guard.commandKind,
      guard.idempotencyKey,
      guard.requestHash,
      guard.resultEntityId,
    );
}
