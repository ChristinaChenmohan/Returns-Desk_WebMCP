-- Additive migration: databases that already applied 0002 must receive these guards.
CREATE TRIGGER guard_proposal_approval
BEFORE UPDATE OF status ON rma_proposals
WHEN NEW.status = 'approved'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM rmas r
    JOIN rma_items ri ON ri.session_id = r.session_id AND ri.rma_id = r.id
    JOIN order_items oi ON oi.session_id = ri.session_id AND oi.id = ri.order_item_id
    JOIN eligibility_checks ec ON ec.session_id = NEW.session_id AND ec.id = NEW.eligibility_check_id
    WHERE r.session_id = NEW.session_id AND r.proposal_id = NEW.id
      AND r.case_id = NEW.case_id AND r.status = 'completed'
      AND r.resolution_type = NEW.resolution_type
      AND ri.order_item_id = NEW.order_item_id AND ri.quantity = NEW.requested_quantity
      AND ri.replacement_variant_id IS NEW.replacement_variant_id
      AND oi.previously_returned_quantity =
        CAST(json_extract(ec.calculation_snapshot_json, '$.input.previouslyReturnedQuantity') AS INTEGER)
        + NEW.requested_quantity
      AND (SELECT COUNT(*) FROM rma_items i WHERE i.session_id = r.session_id AND i.rma_id = r.id) = 1
      AND (SELECT COUNT(*) FROM return_labels l WHERE l.session_id = r.session_id AND l.rma_id = r.id) = NEW.return_required
      AND (
        (NEW.resolution_type = 'refund'
          AND EXISTS (SELECT 1 FROM simulated_refunds f
            JOIN return_cases c ON c.session_id = r.session_id AND c.id = r.case_id
            JOIN orders o ON o.session_id = c.session_id AND o.id = c.order_id
            WHERE f.session_id = r.session_id AND f.rma_id = r.id
              AND f.amount_cents = NEW.refund_amount_cents AND f.currency = o.currency)
          AND NOT EXISTS (SELECT 1 FROM store_credits s WHERE s.session_id = r.session_id AND s.rma_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM inventory_reservations v WHERE v.session_id = r.session_id AND v.rma_id = r.id))
        OR (NEW.resolution_type = 'store_credit'
          AND EXISTS (SELECT 1 FROM store_credits s
            JOIN return_cases c ON c.session_id = r.session_id AND c.id = r.case_id
            JOIN orders o ON o.session_id = c.session_id AND o.id = c.order_id
            WHERE s.session_id = r.session_id AND s.rma_id = r.id
              AND s.amount_cents = NEW.store_credit_cents AND s.currency = o.currency)
          AND NOT EXISTS (SELECT 1 FROM simulated_refunds f WHERE f.session_id = r.session_id AND f.rma_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM inventory_reservations v WHERE v.session_id = r.session_id AND v.rma_id = r.id))
        OR (NEW.resolution_type = 'exchange'
          AND EXISTS (SELECT 1 FROM inventory_reservations v
            JOIN product_variants pv ON pv.session_id = v.session_id AND pv.id = v.variant_id
            WHERE v.session_id = r.session_id AND v.rma_id = r.id
              AND v.variant_id = NEW.replacement_variant_id AND v.quantity = NEW.requested_quantity AND v.status = 'committed'
              AND pv.inventory_quantity =
                CAST(json_extract(ec.calculation_snapshot_json, '$.input.replacementVariant.inventoryQuantity') AS INTEGER)
                - NEW.requested_quantity
              AND pv.inventory_version =
                CAST(json_extract(ec.calculation_snapshot_json, '$.input.replacementVariant.inventoryVersion') AS INTEGER) + 1)
          AND NOT EXISTS (SELECT 1 FROM simulated_refunds f WHERE f.session_id = r.session_id AND f.rma_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM store_credits s WHERE s.session_id = r.session_id AND s.rma_id = r.id))
      )
  ) THEN RAISE(ABORT, 'APPROVAL_ARTIFACT_MISSING') END;
END;

CREATE TRIGGER guard_proposal_approved_insert
BEFORE INSERT ON rma_proposals
WHEN NEW.status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'APPROVAL_REQUIRES_PENDING_TRANSITION');
END;
