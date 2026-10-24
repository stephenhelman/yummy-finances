-- Locked month snapshots are immutable. Only delivery columns (pdfBlobKey,
-- emailSentAt, emailId, updatedAt) may change after LOCKED.

CREATE OR REPLACE FUNCTION month_snapshot_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'LOCKED' THEN
      RAISE EXCEPTION 'MonthSnapshot % is LOCKED and cannot be deleted', OLD."month"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD."status" = 'LOCKED' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
       OR NEW."month" IS DISTINCT FROM OLD."month"
       OR NEW."dataJson" IS DISTINCT FROM OLD."dataJson"
       OR NEW."inputsHash" IS DISTINCT FROM OLD."inputsHash"
       OR NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt" THEN
      RAISE EXCEPTION 'MonthSnapshot % is LOCKED and immutable', OLD."month"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW."status" = 'LOCKED' AND NEW."lockedAt" IS NULL THEN
    RAISE EXCEPTION 'Locking MonthSnapshot % requires lockedAt', NEW."month"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER month_snapshot_guard_update
  BEFORE UPDATE ON "MonthSnapshot"
  FOR EACH ROW EXECUTE FUNCTION month_snapshot_guard();

CREATE TRIGGER month_snapshot_guard_delete
  BEFORE DELETE ON "MonthSnapshot"
  FOR EACH ROW EXECUTE FUNCTION month_snapshot_guard();

-- TRUNCATE bypasses row triggers; block it too.
CREATE OR REPLACE FUNCTION month_snapshot_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'MonthSnapshot cannot be truncated'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER month_snapshot_guard_truncate
  BEFORE TRUNCATE ON "MonthSnapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION month_snapshot_no_truncate();
