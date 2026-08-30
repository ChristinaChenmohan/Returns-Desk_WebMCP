CREATE TRIGGER trg_rma_proposal_terminal_transition
BEFORE UPDATE OF status ON rma_proposals
FOR EACH ROW
WHEN OLD.status <> 'pending' AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'proposal terminal state cannot transition');
END;

CREATE TRIGGER trg_human_review_parent_insert
BEFORE INSERT ON eligibility_checks
FOR EACH ROW
WHEN NEW.parent_check_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM eligibility_checks AS parent
  WHERE parent.session_id = NEW.session_id
    AND parent.id = NEW.parent_check_id
    AND parent.case_id = NEW.case_id
    AND parent.status = 'needs_review'
)
BEGIN
  SELECT RAISE(ABORT, 'review parent must be needs_review in the same case');
END;

CREATE TRIGGER trg_human_review_parent_update
BEFORE UPDATE OF parent_check_id, case_id, session_id ON eligibility_checks
FOR EACH ROW
WHEN NEW.parent_check_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM eligibility_checks AS parent
  WHERE parent.session_id = NEW.session_id
    AND parent.id = NEW.parent_check_id
    AND parent.case_id = NEW.case_id
    AND parent.status = 'needs_review'
)
BEGIN
  SELECT RAISE(ABORT, 'review parent must be needs_review in the same case');
END;
