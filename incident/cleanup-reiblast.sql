-- ============================================================================
-- incident/cleanup-reiblast.sql  --  DESTRUCTIVE, run ONLY after reviewing inspect-reiblast.sql
--
-- INCIDENT: Yummy migrations 0001_init and 0002_full_schema were run against the
-- REIblast production database by mistake. 0001 applied fully. 0002 stopped at
--   ERROR: relation "JobRun" already exists (42P07)
-- because "JobRun" belongs to REIblast. Statements run in file order, so only the
-- objects created BEFORE `CREATE TABLE "JobRun"` can exist from this run.
--
-- Generated offline from prisma/migrations/*/migration.sql. Never executed by the
-- generator. All matching is on schema "public".
--
-- OBJECTS FROM THIS RUN (candidate for cleanup), in migration order
--   0001_init          TABLE Business
--   0002_full_schema   ENUM  PlaidItemStatus, CategorySection, RuleMatchType,
--                            TransactionKind, CategorySource, SettlementMatchStatus,
--                            SnapshotStatus, JobStatus
--                      TABLE PlaidItem, BankAccount, Category, Rule, BankTransaction,
--                            CloverPayment, CloverRefund, Settlement, MonthSnapshot,
--                            LoginToken
--
-- EXCLUDED, NEVER TOUCHED
--   TABLE "JobRun"   REIblast's. Not dropped, not altered, not read by the cleanup.
--   SCHEMA public    created by 0001 with IF NOT EXISTS; it is REIblast's. Never dropped.
--   TABLE _prisma_migrations  kept; only two rows may be deleted from it (cleanup).
--
-- NEVER RAN (after the failing statement; not in cleanup, not in this run):
--   0002: TABLE AuditLog; all 23 indexes; all 19 foreign keys.
--   0003_snapshot_immutability: functions month_snapshot_guard(), month_snapshot_no_truncate();
--         triggers month_snapshot_guard_update/_delete/_truncate. (Prisma stops at the first
--         failed migration, so 0003 never started.)
--   If any of these EXIST in the database, they are not from this run. Leave them alone.
-- ============================================================================

-- PRECONDITIONS
--   1. You ran inspect-reiblast.sql and every present object showed YUMMY_MATCH.
--   2. You confirmed the connection is the REIblast database you mean to clean, and that you
--      have a Neon restore point / branch of it (Neon: create a branch from "now" first).
--
-- DESIGN
--   * One transaction. Any failed guard RAISEs, the transaction aborts, nothing changes.
--     (Run with psql -v ON_ERROR_STOP=1 -f; in the Neon SQL editor the whole script is one
--     batch and an error also rolls it back. Do NOT paste only part of it.)
--   * Guard first. An object is dropped only if it exists AND its columns/enum labels are an
--     exact match for the Yummy migration AND the table has <= 10 rows. Anything else
--     aborts the whole cleanup; we never "skip and continue", you decide by hand.
--   * Plain DROP (RESTRICT), deliberately NOT CASCADE. The FKs between these tables never
--     ran, so they have no dependents of their own. CASCADE would only add the ability to
--     silently drop something of REIblast's that references them (a view, an FK, a trigger).
--     With RESTRICT, a surprise dependency makes the DROP fail and the transaction roll back.
--   * Each DROP uses IF EXISTS, so it is correct whether 0002 rolled back (objects absent)
--     or was applied statement-by-statement (objects present).
--   * Enums are dropped last, and only after checking nothing outside the Yummy tables
--     uses them.
--   * Not dropped, ever: "JobRun", AuditLog, schema public, table _prisma_migrations,
--     and anything not listed above.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------- GUARD
DO $guard$
DECLARE
  max_rows constant bigint := 10;  -- "a handful": Yummy was never seeded here, expect 0
  rec record;
  n bigint;
  actual text;
BEGIN
  -- Tables: exact shape + row count
  FOR rec IN
    SELECT * FROM (VALUES
      ('Business', 'ccEmail:text,createdAt:timestamp,fiscalYearStartMonth:int4,id:text,name:text,ownerEmail:text,timezone:text,updatedAt:timestamp', '0001_init'),
      ('PlaidItem', 'accessTokenEnc:text,businessId:text,createdAt:timestamp,cursor:text,id:text,institutionName:text,lastError:text,lastSyncAt:timestamp,plaidItemId:text,status:PlaidItemStatus,updatedAt:timestamp', '0002_full_schema'),
      ('BankAccount', 'businessId:text,createdAt:timestamp,id:text,mask:text,name:text,plaidAccountId:text,plaidItemId:text,subtype:text,type:text,updatedAt:timestamp', '0002_full_schema'),
      ('Category', 'businessId:text,createdAt:timestamp,id:text,isSystem:bool,name:text,section:CategorySection,sortOrder:int4,updatedAt:timestamp', '0002_full_schema'),
      ('Rule', 'active:bool,amountMaxCents:int4,amountMinCents:int4,businessId:text,categoryId:text,createdAt:timestamp,id:text,matchType:RuleMatchType,pattern:text,priority:int4,updatedAt:timestamp', '0002_full_schema'),
      ('BankTransaction', 'accountId:text,adjustmentMonth:text,amountCents:int4,authorizedDate:date,businessId:text,categoryId:text,categorySource:CategorySource,createdAt:timestamp,date:date,id:text,isLate:bool,kind:TransactionKind,merchantName:text,normalizedMerchant:text,pending:bool,pendingTransactionId:text,plaidTransactionId:text,rawDescription:text,removedAt:timestamp,ruleId:text,updatedAt:timestamp', '0002_full_schema'),
      ('CloverPayment', 'adjustmentMonth:text,amountCents:int4,businessId:text,cloverId:text,createdAt:timestamp,createdTime:timestamp,id:text,isLate:bool,orderId:text,raw:jsonb,result:text,taxCents:int4,tipCents:int4,updatedAt:timestamp', '0002_full_schema'),
      ('CloverRefund', 'adjustmentMonth:text,amountCents:int4,businessId:text,cloverId:text,createdAt:timestamp,createdTime:timestamp,id:text,isLate:bool,paymentId:text,raw:jsonb,status:text,taxCents:int4,tipCents:int4,updatedAt:timestamp,voided:bool', '0002_full_schema'),
      ('Settlement', 'bankTransactionId:text,businessId:text,cloverGrossCents:int4,createdAt:timestamp,depositCents:int4,id:text,impliedFeeCents:int4,matchStatus:SettlementMatchStatus,note:text,periodEnd:timestamp,periodStart:timestamp,updatedAt:timestamp', '0002_full_schema'),
      ('MonthSnapshot', 'businessId:text,createdAt:timestamp,dataJson:jsonb,emailId:text,emailSentAt:timestamp,id:text,inputsHash:text,lockedAt:timestamp,month:text,pdfBlobKey:text,status:SnapshotStatus,updatedAt:timestamp', '0002_full_schema'),
      ('LoginToken', 'businessId:text,createdAt:timestamp,email:text,expiresAt:timestamp,id:text,tokenHash:text,usedAt:timestamp', '0002_full_schema')
    ) AS v(name, cols, migration)
  LOOP
    IF to_regclass(format('public.%I', rec.name)) IS NULL THEN CONTINUE; END IF;

    SELECT (SELECT string_agg(a.attname || ':' || t.typname, ',' ORDER BY a.attname COLLATE "C")
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = to_regclass(format('public.%I', rec.name))::oid AND a.attnum > 0 AND NOT a.attisdropped) INTO actual
      FROM pg_class c WHERE c.oid = to_regclass(format('public.%I', rec.name));
    IF actual IS DISTINCT FROM rec.cols THEN
      RAISE EXCEPTION 'ABORT: public.% exists but is not the Yummy table (columns differ: %). Not dropping. Investigate.', rec.name, actual;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I', rec.name) INTO n;
    IF n > max_rows THEN
      RAISE EXCEPTION 'ABORT: public.% has % rows (> %). Not dropping. Investigate.', rec.name, n, max_rows;
    END IF;
  END LOOP;

  -- Nothing outside the Yummy tables may reference them (FKs) ...
  FOR rec IN
    SELECT con.conname, con.conrelid::regclass::text AS referencing, cl.relname AS target
      FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.confrelid
     WHERE con.contype = 'f' AND cl.relnamespace = 'public'::regnamespace
       AND cl.relname IN ('Business', 'PlaidItem', 'BankAccount', 'Category', 'Rule', 'BankTransaction', 'CloverPayment', 'CloverRefund', 'Settlement', 'MonthSnapshot', 'LoginToken')
       AND NOT (con.conrelid::regclass::text = ANY(ARRAY['Business', 'PlaidItem', 'BankAccount', 'Category', 'Rule', 'BankTransaction', 'CloverPayment', 'CloverRefund', 'Settlement', 'MonthSnapshot', 'LoginToken']))
  LOOP
    RAISE EXCEPTION 'ABORT: % on % references Yummy-named table public.%. Not dropping.', rec.conname, rec.referencing, rec.target;
  END LOOP;

  -- Enums: exact labels, and unused outside the Yummy tables
  FOR rec IN
    SELECT * FROM (VALUES
      ('PlaidItemStatus', 'OK,LOGIN_REQUIRED,ERROR'),
      ('CategorySection', 'REVENUE,COGS,OPEX,OTHER,NON_PL'),
      ('RuleMatchType', 'EXACT,CONTAINS,REGEX'),
      ('TransactionKind', 'EXPENSE,CLOVER_SETTLEMENT,TRANSFER,OWNER_DRAW,IGNORE'),
      ('CategorySource', 'NONE,RULE,MANUAL'),
      ('SettlementMatchStatus', 'MATCHED,NEEDS_REVIEW,UNMATCHED'),
      ('SnapshotStatus', 'DRAFT,LOCKED'),
      ('JobStatus', 'RUNNING,SUCCEEDED,FAILED')
    ) AS v(name, labels)
  LOOP
    SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) INTO actual
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname = rec.name AND t.typnamespace = 'public'::regnamespace;
    IF actual IS NULL THEN CONTINUE; END IF;  -- absent
    IF actual <> rec.labels THEN
      RAISE EXCEPTION 'ABORT: enum public.% exists but labels differ (%). Not dropping.', rec.name, actual;
    END IF;

    FOR n IN
      SELECT count(*) FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r','p','v','m')
        JOIN pg_type t ON t.oid = a.atttypid
       WHERE a.attnum > 0 AND NOT a.attisdropped
         AND t.typname = rec.name AND t.typnamespace = 'public'::regnamespace
         AND NOT (c.relnamespace = 'public'::regnamespace AND c.relname IN ('Business', 'PlaidItem', 'BankAccount', 'Category', 'Rule', 'BankTransaction', 'CloverPayment', 'CloverRefund', 'Settlement', 'MonthSnapshot', 'LoginToken'))
    LOOP
      IF n > 0 THEN
        RAISE EXCEPTION 'ABORT: enum public.% is used by % column(s) outside the Yummy tables (REIblast shares it). Not dropping.', rec.name, n;
      END IF;
    END LOOP;
  END LOOP;

  -- _prisma_migrations: the two rows, if present, must be Yummy's (checksum), and nothing else is deleted
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    FOR rec IN
      SELECT migration_name, checksum FROM public._prisma_migrations
       WHERE migration_name IN ('0001_init', '0002_full_schema')
    LOOP
      IF rec.checksum IS DISTINCT FROM (CASE rec.migration_name
            WHEN '0001_init' THEN 'db998907d02393327ea3295597e764d1dd638685c8b3910ab171bcf08e198146'
            WHEN '0002_full_schema' THEN '7ea168bc092daca503f4d69aacb529b9ac342132a962126d00324611d921173e' END) THEN
        RAISE EXCEPTION 'ABORT: _prisma_migrations row % has a checksum that is not Yummy''s. Not deleting.', rec.migration_name;
      END IF;
    END LOOP;
  END IF;

  RAISE NOTICE 'Guard passed.';
END
$guard$;

-- ---------------------------------------------------------------- DROPS
-- Tables first (none reference each other: the 0002 foreign keys never ran).
-- Order is reverse migration order for readability.
-- NOT dropped here, on purpose:  "JobRun"  (REIblast's table; the failing statement)
--                                "AuditLog" (never ran)
DROP TABLE IF EXISTS public."LoginToken";
DROP TABLE IF EXISTS public."MonthSnapshot";
DROP TABLE IF EXISTS public."Settlement";
DROP TABLE IF EXISTS public."CloverRefund";
DROP TABLE IF EXISTS public."CloverPayment";
DROP TABLE IF EXISTS public."BankTransaction";
DROP TABLE IF EXISTS public."Rule";
DROP TABLE IF EXISTS public."Category";
DROP TABLE IF EXISTS public."BankAccount";
DROP TABLE IF EXISTS public."PlaidItem";
DROP TABLE IF EXISTS public."Business";

-- Enums (reverse order). Guard above proved they are Yummy's and unused elsewhere.
DROP TYPE IF EXISTS public."JobStatus";
DROP TYPE IF EXISTS public."SnapshotStatus";
DROP TYPE IF EXISTS public."SettlementMatchStatus";
DROP TYPE IF EXISTS public."CategorySource";
DROP TYPE IF EXISTS public."TransactionKind";
DROP TYPE IF EXISTS public."RuleMatchType";
DROP TYPE IF EXISTS public."CategorySection";
DROP TYPE IF EXISTS public."PlaidItemStatus";

-- ---------------------------------------------------------------- MIGRATION HISTORY
-- Exactly two rows, by name. The table itself and every other row stay.
DO $hist$
DECLARE deleted integer;
BEGIN
  IF to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE NOTICE '_prisma_migrations does not exist; nothing to delete.';
    RETURN;
  END IF;
  DELETE FROM public._prisma_migrations WHERE migration_name IN ('0001_init', '0002_full_schema');
  GET DIAGNOSTICS deleted = ROW_COUNT;
  IF deleted > 2 THEN
    RAISE EXCEPTION 'ABORT: would delete % migration rows (expected at most 2).', deleted;
  END IF;
  RAISE NOTICE 'Deleted % _prisma_migrations row(s).', deleted;
END
$hist$;

-- ---------------------------------------------------------------- POST-CHECK (inside the txn)
-- Raises (and so rolls back everything) if any Yummy object is still there.
DO $post$
DECLARE leftover text;
BEGIN
  SELECT string_agg(x, ', ') INTO leftover FROM (
    SELECT c.relname::text AS x FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname IN ('Business', 'PlaidItem', 'BankAccount', 'Category', 'Rule', 'BankTransaction', 'CloverPayment', 'CloverRefund', 'Settlement', 'MonthSnapshot', 'LoginToken')
    UNION ALL
    SELECT t.typname::text FROM pg_type t
     WHERE t.typnamespace = 'public'::regnamespace AND t.typtype = 'e' AND t.typname IN ('PlaidItemStatus', 'CategorySection', 'RuleMatchType', 'TransactionKind', 'CategorySource', 'SettlementMatchStatus', 'SnapshotStatus', 'JobStatus')
  ) s;
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: still present after drops: %', leftover;
  END IF;
END
$post$;

COMMIT;
