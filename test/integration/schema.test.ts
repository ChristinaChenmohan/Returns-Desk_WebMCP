/// <reference types="@cloudflare/vitest-plugin/types" />

import { describe, expect, it } from "vitest";
import { db } from "./setup";

const NOW = "2026-08-29T08:00:00Z";
const LATER = "2026-08-29T08:15:00Z";

async function seedCase(caseId: string): Promise<void> {
  const sessionId = `session_${caseId}`;
  const customerId = `customer_${caseId}`;
  const productId = `product_${caseId}`;
  const variantId = `variant_${caseId}`;
  const policyId = `policy_${caseId}`;
  const orderId = `order_${caseId}`;
  const itemId = `item_${caseId}`;

  await db.batch([
    db.prepare(
      "INSERT INTO demo_sessions (id, created_at, expires_at, seed_version, reset_count) VALUES (?, ?, ?, 1, 0)",
    ).bind(sessionId, NOW, "2026-08-30T08:00:00Z"),
    db.prepare(
      "INSERT INTO customers (id, session_id, name, email_normalized, locale) VALUES (?, ?, ?, ?, ?)",
    ).bind(customerId, sessionId, "Schema Customer", `${caseId}@example.test`, "en-US"),
    db.prepare(
      `INSERT INTO products
        (id, session_id, title, category, final_sale, returnable_condition)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).bind(productId, sessionId, "Schema Shoe", "footwear", "unopened"),
    db.prepare(
      `INSERT INTO product_variants
        (id, session_id, product_id, sku, title, option_values_json, price_cents,
         inventory_quantity, inventory_version, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).bind(
      variantId,
      sessionId,
      productId,
      `SCHEMA-${caseId}`,
      "Size 8",
      '{"size":"8"}',
      12900,
      4,
      1,
    ),
    db.prepare(
      `INSERT INTO policy_versions
        (id, session_id, version_number, name, effective_from, effective_to,
         default_window_days, absolute_max_window_days, default_return_required,
         default_resolutions_json, return_shipping_payer, status, version)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, 1)`,
    ).bind(
      policyId,
      sessionId,
      1,
      "Schema Policy",
      "2026-01-01T00:00:00Z",
      30,
      60,
      '["exchange","refund","store_credit"]',
      "merchant",
      "active",
    ),
    db.prepare(
      `INSERT INTO orders
        (id, session_id, order_number, customer_id, currency, status, ordered_at,
         fulfilled_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      orderId,
      sessionId,
      `ORD-${caseId}`,
      customerId,
      "USD",
      "delivered",
      "2026-08-01T08:00:00Z",
      "2026-08-02T08:00:00Z",
      "2026-08-05T08:00:00Z",
    ),
    db.prepare(
      `INSERT INTO order_items
        (id, session_id, order_id, variant_id, quantity, unit_price_cents,
         fulfilled_quantity, previously_returned_quantity, policy_version_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      itemId,
      sessionId,
      orderId,
      variantId,
      1,
      12900,
      1,
      0,
      policyId,
    ),
    db.prepare(
      `INSERT INTO return_cases
        (id, session_id, order_id, customer_id, status, source, reason_code,
         condition_code, customer_note, opened_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
    ).bind(
      caseId,
      sessionId,
      orderId,
      customerId,
      "open",
      "agent",
      "wrong_size",
      "opened_unused",
      NOW,
      NOW,
    ),
    db.prepare(
      `INSERT INTO eligibility_checks
        (id, session_id, case_id, order_item_id, policy_version_id, requested_quantity,
         reason_code, condition_code, status, allowed_resolutions_json,
         return_required, return_shipping_payer, matched_rules_json,
         calculation_snapshot_json, input_hash, parent_check_id, review_source,
         reviewed_by, reviewed_at, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
    ).bind(
      `check_${caseId}`,
      sessionId,
      caseId,
      itemId,
      policyId,
      "wrong_size",
      "opened_unused",
      "eligible",
      '["exchange","refund","store_credit"]',
      "merchant",
      "[]",
      '{"input":{"previouslyReturnedQuantity":0,"replacementVariant":{"inventoryQuantity":4,"inventoryVersion":1}}}',
      `hash_${caseId}`,
      "engine",
      NOW,
      LATER,
    ),
  ]);
}

async function insertPending(proposalId: string, caseId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO rma_proposals
      (id, session_id, case_id, eligibility_check_id, order_item_id, resolution_type,
       requested_quantity, replacement_variant_id, refund_amount_cents,
       store_credit_cents, merchant_cost_cents, customer_message_json, status,
       idempotency_key, request_hash, return_required, created_by, created_at,
       expires_at, version)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`,
  ).bind(
    proposalId,
    `session_${caseId}`,
    caseId,
    `check_${caseId}`,
    `item_${caseId}`,
    "exchange",
    `variant_${caseId}`,
    300,
    '{"subject":"Exchange","bodyText":"We can exchange this item.","locale":"en-US"}',
    "pending",
    `idem_${proposalId}`,
    `request_${proposalId}`,
    "agent",
    NOW,
    LATER,
  ).run();
}

async function insertApprovedFixture(): Promise<void> {
  await seedCase("case_approved");
  await insertPending("prop_1", "case_approved");
  await db.prepare(
    `INSERT INTO rmas
      (id, session_id, rma_number, case_id, proposal_id, resolution_type,
       status, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    "rma_1",
    "session_case_approved",
    "RMA-1",
    "case_approved",
    "prop_1",
    "exchange",
    "completed",
    NOW,
    NOW,
  ).run();
  await db.batch([
    db.prepare(`INSERT INTO rma_items (id, session_id, rma_id, order_item_id, quantity, replacement_variant_id)
      VALUES ('ri_1', 'session_case_approved', 'rma_1', 'item_case_approved', 1, 'variant_case_approved')`),
    db.prepare(`INSERT INTO inventory_reservations
      (id, session_id, reservation_number, rma_id, variant_id, quantity, status, created_at)
      VALUES ('res_1', 'session_case_approved', 'RES-1', 'rma_1', 'variant_case_approved', 1, 'committed', ?)`)
      .bind(NOW),
    db.prepare(`UPDATE order_items SET previously_returned_quantity = 1
      WHERE session_id = 'session_case_approved' AND id = 'item_case_approved'`),
    db.prepare(`UPDATE product_variants SET inventory_quantity = 3, inventory_version = 2
      WHERE session_id = 'session_case_approved' AND id = 'variant_case_approved'`),
    db.prepare(`INSERT INTO return_labels (id, session_id, label_number, rma_id, tracking_number, created_at)
      VALUES ('label_1', 'session_case_approved', 'LABEL-1', 'rma_1', 'TRACK-1', ?)`)
      .bind(NOW),
    db.prepare(`UPDATE rma_proposals SET status = 'approved', reviewed_at = ?, reviewed_by = ?, version = version + 1
      WHERE session_id = ? AND id = ?`).bind(NOW, "merchant_schema", "session_case_approved", "prop_1"),
  ]);
}

describe("D1 schema invariants", () => {
  it("rejects two pending proposals for one Case", async () => {
    await seedCase("case_1");
    await insertPending("prop_1", "case_1");

    await expect(insertPending("prop_2", "case_1")).rejects.toThrow();
  });

  it("rejects a second RMA for one proposal", async () => {
    await insertApprovedFixture();

    await expect(
      db.prepare(
        `INSERT INTO rmas
          (id, session_id, rma_number, case_id, proposal_id, resolution_type,
           status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "rma_2",
        "session_case_approved",
        "RMA-2",
        "case_approved",
        "prop_1",
        "exchange",
        "completed",
        NOW,
        NOW,
      ).run(),
    ).rejects.toThrow();
  });

  it("allows a same-terminal proposal no-op and rejects a different terminal transition", async () => {
    await insertApprovedFixture();
    const sessionId = "session_case_approved";

    await expect(
      db.prepare(
        `UPDATE rma_proposals
            SET status = 'approved'
          WHERE session_id = ? AND id = ?`,
      ).bind(sessionId, "prop_1").run(),
    ).resolves.toBeDefined();
    await expect(
      db.prepare(
        `UPDATE rma_proposals
            SET status = 'rejected'
          WHERE session_id = ? AND id = ?`,
      ).bind(sessionId, "prop_1").run(),
    ).rejects.toThrow();
  });

  it("requires a needs-review parent in the same Case for human review snapshots", async () => {
    await seedCase("case_review");
    const sessionId = "session_case_review";
    const parentId = "check_case_review";
    const insertReview = (childId: string) => db.prepare(
      `INSERT INTO eligibility_checks
        (id, session_id, case_id, order_item_id, policy_version_id, requested_quantity,
         reason_code, condition_code, status, allowed_resolutions_json,
         return_required, return_shipping_payer, matched_rules_json,
         calculation_snapshot_json, input_hash, parent_check_id, review_source,
         reviewed_by, reviewed_at, created_at, expires_at)
       SELECT ?, session_id, case_id, order_item_id, policy_version_id, requested_quantity,
              reason_code, condition_code, 'eligible', allowed_resolutions_json,
              return_required, return_shipping_payer, matched_rules_json,
              calculation_snapshot_json, ?, id, 'human', ?, ?, ?, ?
         FROM eligibility_checks
        WHERE session_id = ? AND case_id = ? AND id = ?`,
    ).bind(
      childId,
      `hash_${childId}`,
      "merchant_schema",
      NOW,
      NOW,
      LATER,
      sessionId,
      "case_review",
      parentId,
    ).run();

    await expect(insertReview("review_invalid_parent")).rejects.toThrow();
    await db.prepare(
      `UPDATE eligibility_checks
          SET status = 'needs_review'
        WHERE session_id = ? AND case_id = ? AND id = ?`,
    ).bind(sessionId, "case_review", parentId).run();
    await expect(insertReview("review_valid_parent")).resolves.toBeDefined();

    await db.prepare(
      `INSERT INTO return_cases
        (id, session_id, order_id, customer_id, status, source, reason_code,
         condition_code, customer_note, opened_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
    ).bind(
      "case_review_other",
      sessionId,
      "order_case_review",
      "customer_case_review",
      "open",
      "manual",
      "wrong_size",
      "unopened",
      NOW,
      NOW,
    ).run();
    await seedCase("case_review_foreign_session");

    const updateReviewRelationship = (
      nextParentId: string,
      nextCaseId: string,
      nextSessionId: string,
    ) => db.prepare(
      `UPDATE eligibility_checks
          SET parent_check_id = ?, case_id = ?, session_id = ?
        WHERE session_id = ? AND id = ?`,
    ).bind(
      nextParentId,
      nextCaseId,
      nextSessionId,
      sessionId,
      "review_valid_parent",
    ).run();

    await expect(
      updateReviewRelationship(parentId, "case_review", sessionId),
    ).resolves.toBeDefined();

    const invalidRelationships = [
      ["review_valid_parent", "case_review", sessionId],
      [parentId, "case_review_other", sessionId],
      [parentId, "case_review", "session_case_review_foreign_session"],
    ] as const;
    for (const relationship of invalidRelationships) {
      await expect(
        updateReviewRelationship(
          relationship[0],
          relationship[1],
          relationship[2],
        ),
      ).rejects.toThrow("review parent must be needs_review in the same case");
    }

    expect(
      await db.prepare(
        `SELECT parent_check_id, case_id, session_id
           FROM eligibility_checks
          WHERE session_id = ? AND id = ?`,
      ).bind(sessionId, "review_valid_parent").first<{
        parent_check_id: string;
        case_id: string;
        session_id: string;
      }>(),
    ).toEqual({
      parent_check_id: parentId,
      case_id: "case_review",
      session_id: sessionId,
    });
  });

  it("rejects composite foreign keys that cross Sessions", async () => {
    await seedCase("case_cross_a");
    await seedCase("case_cross_b");

    await expect(
      db.prepare(
        `INSERT INTO return_cases
          (id, session_id, order_id, customer_id, status, source, reason_code,
           condition_code, customer_note, opened_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
      ).bind(
        "case_cross_session",
        "session_case_cross_a",
        "order_case_cross_b",
        "customer_case_cross_a",
        "open",
        "manual",
        "wrong_size",
        "unopened",
        NOW,
        NOW,
      ).run(),
    ).rejects.toThrow();
  });

  it("stores money, quantities, versions, and counters as nonnegative integers", async () => {
    await seedCase("case_numbers");
    const sessionId = "session_case_numbers";

    const invalidStatements = [
      db.prepare(
        "UPDATE product_variants SET price_cents = ? WHERE session_id = ? AND id = ?",
      ).bind(129.5, sessionId, "variant_case_numbers"),
      db.prepare(
        "UPDATE product_variants SET inventory_quantity = ? WHERE session_id = ? AND id = ?",
      ).bind(-1, sessionId, "variant_case_numbers"),
      db.prepare(
        "UPDATE return_cases SET version = ? WHERE session_id = ? AND id = ?",
      ).bind(1.5, sessionId, "case_numbers"),
      db.prepare(
        "UPDATE demo_sessions SET reset_count = ? WHERE id = ?",
      ).bind(0.5, sessionId),
    ];
    for (const statement of invalidStatements) {
      await expect(statement.run()).rejects.toThrow();
    }

    await db.prepare(
      "UPDATE product_variants SET price_cents = ?, inventory_quantity = ? WHERE session_id = ? AND id = ?",
    ).bind(13000, 3, sessionId, "variant_case_numbers").run();
    expect(
      await db.prepare(
        `SELECT typeof(price_cents) AS money_type,
                typeof(inventory_quantity) AS quantity_type
           FROM product_variants
          WHERE session_id = ? AND id = ?`,
      ).bind(sessionId, "variant_case_numbers").first<{
        money_type: string;
        quantity_type: string;
      }>(),
    ).toEqual({ money_type: "integer", quantity_type: "integer" });
  });

  it("accepts canonical UTC timestamps and rejects trailing-Z lookalikes", async () => {
    await db.prepare(
      `INSERT INTO demo_sessions
        (id, created_at, expires_at, seed_version, reset_count)
       VALUES (?, ?, ?, 1, 0)`,
    ).bind(
      "session_time_seconds",
      "2026-08-29T08:00:00Z",
      "2026-08-30T08:00:00Z",
    ).run();
    await db.prepare(
      `INSERT INTO demo_sessions
        (id, created_at, expires_at, seed_version, reset_count)
       VALUES (?, ?, ?, 1, 0)`,
    ).bind(
      "session_time_millis",
      "2026-08-29T08:00:00.123Z",
      "2026-08-30T08:00:00.123Z",
    ).run();

    for (const timestamp of [
      "not-rfc3339Z",
      "2026-08-29 08:00:00Z",
      "2026-08-29T08:00:00junkZ",
    ]) {
      await expect(
        db.prepare(
          `INSERT INTO demo_sessions
            (id, created_at, expires_at, seed_version, reset_count)
           VALUES (?, ?, ?, 1, 0)`,
        ).bind(`session_bad_time_${timestamp.length}`, timestamp, LATER).run(),
      ).rejects.toThrow();
    }
  });

  it("stores rate-limit subjects only as lowercase SHA-256 hex digests", async () => {
    await db.prepare(
      `INSERT INTO demo_sessions
        (id, created_at, expires_at, seed_version, reset_count)
       VALUES (?, ?, ?, 1, 0)`,
    ).bind("session_rate", NOW, LATER).run();
    const digest = "a".repeat(64);

    await db.prepare(
      `INSERT INTO rate_limit_buckets
        (bucket_kind, subject_digest, session_id, window_started_at, request_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind("write", digest, "session_rate", NOW, 1).run();
    await expect(
      db.prepare(
        `INSERT INTO rate_limit_buckets
          (bucket_kind, subject_digest, session_id, window_started_at, request_count)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        "search",
        "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255",
        "session_rate",
        NOW,
        1,
      ).run(),
    ).rejects.toThrow();
    await expect(
      db.prepare(
        `INSERT INTO rate_limit_buckets
          (bucket_kind, subject_digest, session_id, window_started_at, request_count)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind("eligibility", "A".repeat(64), "session_rate", NOW, 1).run(),
    ).rejects.toThrow();
  });
});
