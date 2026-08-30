PRAGMA foreign_keys = ON;

CREATE TABLE demo_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND COALESCE(created_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days')
    ), 0)
  ),
  expires_at TEXT NOT NULL CHECK (
    typeof(expires_at) = 'text' AND COALESCE(expires_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', expires_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days')
    ), 0)
  ),
  seed_version INTEGER NOT NULL CHECK (typeof(seed_version) = 'integer' AND seed_version >= 1),
  reset_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(reset_count) = 'integer' AND reset_count >= 0)
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  locale TEXT NOT NULL,
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id) REFERENCES demo_sessions(id) ON DELETE CASCADE
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  final_sale INTEGER NOT NULL CHECK (typeof(final_sale) = 'integer' AND final_sale IN (0, 1)),
  returnable_condition TEXT NOT NULL,
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id) REFERENCES demo_sessions(id) ON DELETE CASCADE
);

CREATE TABLE product_variants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  option_values_json TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (typeof(price_cents) = 'integer' AND price_cents >= 0),
  inventory_quantity INTEGER NOT NULL CHECK (typeof(inventory_quantity) = 'integer' AND inventory_quantity >= 0),
  inventory_version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(inventory_version) = 'integer' AND inventory_version >= 1),
  active INTEGER NOT NULL CHECK (typeof(active) = 'integer' AND active IN (0, 1)),
  UNIQUE (session_id, id),
  UNIQUE (session_id, sku),
  FOREIGN KEY (session_id, product_id) REFERENCES products(session_id, id) ON DELETE CASCADE
);

CREATE TABLE policy_versions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (typeof(version_number) = 'integer' AND version_number >= 1),
  name TEXT NOT NULL,
  effective_from TEXT NOT NULL CHECK (
    typeof(effective_from) = 'text' AND COALESCE(effective_from IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', effective_from, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', effective_from, '+0 days')
    ), 0)
  ),
  effective_to TEXT CHECK (
    effective_to IS NULL OR (
      typeof(effective_to) = 'text' AND COALESCE(effective_to IN (
        strftime('%Y-%m-%dT%H:%M:%SZ', effective_to, '+0 days'),
        strftime('%Y-%m-%dT%H:%M:%fZ', effective_to, '+0 days')
      ), 0)
    )
  ),
  default_window_days INTEGER NOT NULL CHECK (typeof(default_window_days) = 'integer' AND default_window_days >= 0),
  absolute_max_window_days INTEGER NOT NULL CHECK (
    typeof(absolute_max_window_days) = 'integer'
    AND absolute_max_window_days >= default_window_days
  ),
  default_return_required INTEGER NOT NULL CHECK (
    typeof(default_return_required) = 'integer' AND default_return_required IN (0, 1)
  ),
  default_resolutions_json TEXT NOT NULL,
  return_shipping_payer TEXT NOT NULL CHECK (return_shipping_payer IN ('merchant', 'customer')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  UNIQUE (session_id, id),
  UNIQUE (session_id, version_number),
  FOREIGN KEY (session_id) REFERENCES demo_sessions(id) ON DELETE CASCADE
);

CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (typeof(priority) = 'integer'),
  conditions_json TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  explanation_template TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (typeof(active) = 'integer' AND active IN (0, 1)),
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, policy_version_id) REFERENCES policy_versions(session_id, id) ON DELETE CASCADE
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  ordered_at TEXT NOT NULL CHECK (
    typeof(ordered_at) = 'text' AND COALESCE(ordered_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', ordered_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', ordered_at, '+0 days')
    ), 0)
  ),
  fulfilled_at TEXT CHECK (
    fulfilled_at IS NULL OR (
      typeof(fulfilled_at) = 'text' AND COALESCE(fulfilled_at IN (
        strftime('%Y-%m-%dT%H:%M:%SZ', fulfilled_at, '+0 days'),
        strftime('%Y-%m-%dT%H:%M:%fZ', fulfilled_at, '+0 days')
      ), 0)
    )
  ),
  delivered_at TEXT CHECK (
    delivered_at IS NULL OR (
      typeof(delivered_at) = 'text' AND COALESCE(delivered_at IN (
        strftime('%Y-%m-%dT%H:%M:%SZ', delivered_at, '+0 days'),
        strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at, '+0 days')
      ), 0)
    )
  ),
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, customer_id) REFERENCES customers(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id) REFERENCES demo_sessions(id) ON DELETE CASCADE
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (typeof(unit_price_cents) = 'integer' AND unit_price_cents >= 0),
  fulfilled_quantity INTEGER NOT NULL CHECK (
    typeof(fulfilled_quantity) = 'integer'
    AND fulfilled_quantity >= 0 AND fulfilled_quantity <= quantity
  ),
  previously_returned_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(previously_returned_quantity) = 'integer'
      AND previously_returned_quantity >= 0
      AND previously_returned_quantity <= fulfilled_quantity
    ),
  policy_version_id TEXT NOT NULL,
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, order_id) REFERENCES orders(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, variant_id) REFERENCES product_variants(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, policy_version_id) REFERENCES policy_versions(session_id, id) ON DELETE RESTRICT
);

CREATE TABLE return_cases (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('agent', 'manual')),
  reason_code TEXT NOT NULL,
  condition_code TEXT NOT NULL,
  customer_note TEXT,
  opened_at TEXT NOT NULL CHECK (
    typeof(opened_at) = 'text' AND COALESCE(opened_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', opened_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', opened_at, '+0 days')
    ), 0)
  ),
  updated_at TEXT NOT NULL CHECK (
    typeof(updated_at) = 'text' AND COALESCE(updated_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days')
    ), 0)
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, order_id) REFERENCES orders(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, customer_id) REFERENCES customers(session_id, id) ON DELETE RESTRICT
);

CREATE TABLE eligibility_checks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  requested_quantity INTEGER NOT NULL CHECK (typeof(requested_quantity) = 'integer' AND requested_quantity > 0),
  reason_code TEXT NOT NULL,
  condition_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('eligible', 'ineligible', 'needs_review')),
  allowed_resolutions_json TEXT NOT NULL,
  return_required INTEGER NOT NULL CHECK (typeof(return_required) = 'integer' AND return_required IN (0, 1)),
  return_shipping_payer TEXT NOT NULL CHECK (return_shipping_payer IN ('merchant', 'customer')),
  matched_rules_json TEXT NOT NULL,
  calculation_snapshot_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  parent_check_id TEXT,
  review_source TEXT NOT NULL CHECK (review_source IN ('engine', 'human')),
  reviewed_by TEXT,
  reviewed_at TEXT CHECK (
    reviewed_at IS NULL OR (
      typeof(reviewed_at) = 'text' AND COALESCE(reviewed_at IN (
        strftime('%Y-%m-%dT%H:%M:%SZ', reviewed_at, '+0 days'),
        strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at, '+0 days')
      ), 0)
    )
  ),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND COALESCE(created_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days')
    ), 0)
  ),
  expires_at TEXT NOT NULL CHECK (
    typeof(expires_at) = 'text' AND COALESCE(expires_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', expires_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days')
    ), 0)
  ),
  UNIQUE (session_id, id),
  UNIQUE (session_id, id, case_id),
  CHECK (
    (review_source = 'engine' AND parent_check_id IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR
    (review_source = 'human' AND parent_check_id IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  FOREIGN KEY (session_id, case_id) REFERENCES return_cases(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, order_item_id) REFERENCES order_items(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, policy_version_id) REFERENCES policy_versions(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, parent_check_id) REFERENCES eligibility_checks(session_id, id) ON DELETE CASCADE
);

CREATE TABLE rma_proposals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  eligibility_check_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  resolution_type TEXT NOT NULL CHECK (resolution_type IN ('exchange', 'refund', 'store_credit')),
  requested_quantity INTEGER NOT NULL CHECK (typeof(requested_quantity) = 'integer' AND requested_quantity > 0),
  replacement_variant_id TEXT,
  refund_amount_cents INTEGER CHECK (
    refund_amount_cents IS NULL
    OR (typeof(refund_amount_cents) = 'integer' AND refund_amount_cents >= 0)
  ),
  store_credit_cents INTEGER CHECK (
    store_credit_cents IS NULL
    OR (typeof(store_credit_cents) = 'integer' AND store_credit_cents >= 0)
  ),
  merchant_cost_cents INTEGER NOT NULL CHECK (
    typeof(merchant_cost_cents) = 'integer' AND merchant_cost_cents >= 0
  ),
  customer_message_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'superseded', 'invalidated')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  return_required INTEGER NOT NULL CHECK (typeof(return_required) = 'integer' AND return_required IN (0, 1)),
  created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'human')),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND COALESCE(created_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days')
    ), 0)
  ),
  expires_at TEXT NOT NULL CHECK (
    typeof(expires_at) = 'text' AND COALESCE(expires_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', expires_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days')
    ), 0)
  ),
  reviewed_at TEXT CHECK (
    reviewed_at IS NULL OR (
      typeof(reviewed_at) = 'text' AND COALESCE(reviewed_at IN (
        strftime('%Y-%m-%dT%H:%M:%SZ', reviewed_at, '+0 days'),
        strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at, '+0 days')
      ), 0)
    )
  ),
  reviewed_by TEXT,
  rejection_reason_code TEXT,
  invalidated_reason_code TEXT,
  review_note TEXT,
  superseded_by_proposal_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  UNIQUE (session_id, id),
  UNIQUE (session_id, idempotency_key),
  CHECK (
    (resolution_type = 'exchange' AND replacement_variant_id IS NOT NULL AND refund_amount_cents IS NULL AND store_credit_cents IS NULL)
    OR
    (resolution_type = 'refund' AND replacement_variant_id IS NULL AND refund_amount_cents IS NOT NULL AND store_credit_cents IS NULL)
    OR
    (resolution_type = 'store_credit' AND replacement_variant_id IS NULL AND refund_amount_cents IS NULL AND store_credit_cents IS NOT NULL)
  ),
  FOREIGN KEY (session_id, case_id) REFERENCES return_cases(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, eligibility_check_id, case_id)
    REFERENCES eligibility_checks(session_id, id, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, order_item_id) REFERENCES order_items(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, replacement_variant_id) REFERENCES product_variants(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, superseded_by_proposal_id) REFERENCES rma_proposals(session_id, id) ON DELETE RESTRICT
);

CREATE TABLE rmas (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  rma_number TEXT NOT NULL,
  case_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  resolution_type TEXT NOT NULL CHECK (resolution_type IN ('exchange', 'refund', 'store_credit')),
  status TEXT NOT NULL CHECK (status = 'completed'),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND COALESCE(created_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days')
    ), 0)
  ),
  completed_at TEXT NOT NULL CHECK (
    typeof(completed_at) = 'text' AND COALESCE(completed_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', completed_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', completed_at, '+0 days')
    ), 0)
  ),
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, case_id) REFERENCES return_cases(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, proposal_id) REFERENCES rma_proposals(session_id, id) ON DELETE RESTRICT
);

CREATE TABLE rma_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  rma_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
  replacement_variant_id TEXT,
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, rma_id) REFERENCES rmas(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, order_item_id) REFERENCES order_items(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, replacement_variant_id) REFERENCES product_variants(session_id, id) ON DELETE RESTRICT
);

CREATE TABLE inventory_reservations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  reservation_number TEXT NOT NULL,
  rma_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
  status TEXT NOT NULL CHECK (status = 'committed'),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND COALESCE(created_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days')
    ), 0)
  ),
  UNIQUE (session_id, id),
  UNIQUE (session_id, reservation_number),
  FOREIGN KEY (session_id, rma_id) REFERENCES rmas(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, variant_id) REFERENCES product_variants(session_id, id) ON DELETE RESTRICT
);

CREATE TABLE simulated_refunds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  refund_number TEXT NOT NULL,
  rma_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND COALESCE(created_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days')
    ), 0)
  ),
  UNIQUE (session_id, id),
  UNIQUE (session_id, refund_number),
  FOREIGN KEY (session_id, rma_id) REFERENCES rmas(session_id, id) ON DELETE CASCADE
);

CREATE TABLE store_credits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  credit_number TEXT NOT NULL,
  rma_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND COALESCE(created_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days')
    ), 0)
  ),
  UNIQUE (session_id, id),
  UNIQUE (session_id, credit_number),
  FOREIGN KEY (session_id, rma_id) REFERENCES rmas(session_id, id) ON DELETE CASCADE
);

CREATE TABLE return_labels (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  label_number TEXT NOT NULL,
  rma_id TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND COALESCE(created_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days')
    ), 0)
  ),
  UNIQUE (session_id, id),
  UNIQUE (session_id, label_number),
  UNIQUE (session_id, tracking_number),
  FOREIGN KEY (session_id, rma_id) REFERENCES rmas(session_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  case_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent', 'human', 'system')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND COALESCE(created_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days')
    ), 0)
  ),
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id) REFERENCES demo_sessions(id) ON DELETE CASCADE
);

CREATE TABLE idempotency_records (
  session_id TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL,
  result_entity_type TEXT NOT NULL,
  result_entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND COALESCE(created_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days')
    ), 0)
  ),
  PRIMARY KEY (session_id, command_kind, idempotency_key),
  FOREIGN KEY (session_id) REFERENCES demo_sessions(id) ON DELETE CASCADE
);

CREATE TABLE rate_limit_buckets (
  bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('search', 'eligibility', 'write')),
  subject_digest TEXT NOT NULL CHECK (
    typeof(subject_digest) = 'text'
    AND length(subject_digest) = 64
    AND subject_digest NOT GLOB '*[^0-9a-f]*'
  ),
  session_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL CHECK (
    typeof(window_started_at) = 'text' AND COALESCE(window_started_at IN (
      strftime('%Y-%m-%dT%H:%M:%SZ', window_started_at, '+0 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', window_started_at, '+0 days')
    ), 0)
  ),
  request_count INTEGER NOT NULL CHECK (typeof(request_count) = 'integer' AND request_count >= 0),
  PRIMARY KEY (bucket_kind, subject_digest),
  FOREIGN KEY (session_id) REFERENCES demo_sessions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX ux_orders_session_number ON orders(session_id, order_number);
CREATE UNIQUE INDEX ux_one_pending_proposal_per_case
  ON rma_proposals(case_id) WHERE status = 'pending';
CREATE UNIQUE INDEX ux_rma_proposal ON rmas(proposal_id);
CREATE UNIQUE INDEX ux_rma_number ON rmas(session_id, rma_number);
CREATE UNIQUE INDEX ux_inventory_reservation_rma ON inventory_reservations(rma_id);
CREATE UNIQUE INDEX ux_return_label_rma ON return_labels(rma_id);
CREATE UNIQUE INDEX ux_refund_rma ON simulated_refunds(rma_id);
CREATE UNIQUE INDEX ux_store_credit_rma ON store_credits(rma_id);

CREATE INDEX ix_products_session ON products(session_id);
CREATE INDEX ix_variants_session_product ON product_variants(session_id, product_id);
CREATE INDEX ix_customers_session ON customers(session_id);
CREATE INDEX ix_orders_session_customer ON orders(session_id, customer_id);
CREATE INDEX ix_order_items_session_order ON order_items(session_id, order_id);
CREATE INDEX ix_policy_versions_session_status ON policy_versions(session_id, status);
CREATE INDEX ix_policy_rules_session_version ON policy_rules(session_id, policy_version_id);
CREATE INDEX ix_cases_session_status ON return_cases(session_id, status);
CREATE INDEX ix_checks_session_case ON eligibility_checks(session_id, case_id);
CREATE INDEX ix_proposals_session_case_status ON rma_proposals(session_id, case_id, status);
CREATE INDEX ix_rmas_session_case ON rmas(session_id, case_id);
CREATE INDEX ix_audit_session_case_time ON audit_events(session_id, case_id, created_at);
