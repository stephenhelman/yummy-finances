-- ============================================================================
-- incident/inspect-reiblast.sql  --  READ ONLY
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

-- Run this first, in psql or the Neon SQL editor against the REIblast database
-- (confirm the endpoint yourself before running). Every statement is a SELECT, and the
-- session is forced read-only. Run it as one script (psql -f) or one block at a time.
--
-- How to read it:
--   * Section 1: for each object this run could have created, does it exist, and does its
--     shape (columns/types, enum labels) match the Yummy migration exactly?
--       status YUMMY_MATCH     -> exists and fingerprint identical: the cleanup will drop it.
--       status SHAPE_MISMATCH  -> exists but is NOT the Yummy shape: someone else's. The
--                                 cleanup will ABORT. Do not drop; investigate.
--       status ABSENT          -> nothing to do (expected if 0002 was rolled back).
--   * Section 2: row counts of the Yummy tables. Expect 0 (nothing was seeded).
--   * Section 3: _prisma_migrations rows for the two names + checksum comparison.
--   * Section 4: never-ran objects. Expect ABSENT. Anything present is not from this run.
--   * Section 5: JobRun (catalog only; shown so you can see it is NOT Yummy's) and
--     dependencies that would block a drop.

BEGIN READ ONLY;

-- 1. Existence + shape of every object this run could have created -------------
WITH expected_tables(name, cols, migration) AS (VALUES
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
)
SELECT 'TABLE' AS kind, e.name, e.migration,
       CASE WHEN c.oid IS NULL THEN 'ABSENT'
            WHEN (SELECT string_agg(a.attname || ':' || t.typname, ',' ORDER BY a.attname COLLATE "C")
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) = e.cols THEN 'YUMMY_MATCH'
            ELSE 'SHAPE_MISMATCH' END AS status,
       CASE WHEN c.oid IS NOT NULL AND (SELECT string_agg(a.attname || ':' || t.typname, ',' ORDER BY a.attname COLLATE "C")
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) <> e.cols THEN (SELECT string_agg(a.attname || ':' || t.typname, ',' ORDER BY a.attname COLLATE "C")
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) END AS actual_columns
  FROM expected_tables e
  LEFT JOIN pg_class c ON c.relname = e.name AND c.relkind = 'r'
       AND c.relnamespace = 'public'::regnamespace
 ORDER BY e.migration, e.name;

WITH expected_enums(name, labels) AS (VALUES
    ('PlaidItemStatus', 'OK,LOGIN_REQUIRED,ERROR'),
    ('CategorySection', 'REVENUE,COGS,OPEX,OTHER,NON_PL'),
    ('RuleMatchType', 'EXACT,CONTAINS,REGEX'),
    ('TransactionKind', 'EXPENSE,CLOVER_SETTLEMENT,TRANSFER,OWNER_DRAW,IGNORE'),
    ('CategorySource', 'NONE,RULE,MANUAL'),
    ('SettlementMatchStatus', 'MATCHED,NEEDS_REVIEW,UNMATCHED'),
    ('SnapshotStatus', 'DRAFT,LOCKED'),
    ('JobStatus', 'RUNNING,SUCCEEDED,FAILED')
)
SELECT 'ENUM' AS kind, e.name, '0002_full_schema' AS migration,
       CASE WHEN t.oid IS NULL THEN 'ABSENT'
            WHEN (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
                    FROM pg_enum WHERE enumtypid = t.oid) = e.labels THEN 'YUMMY_MATCH'
            ELSE 'SHAPE_MISMATCH' END AS status,
       CASE WHEN t.oid IS NOT NULL THEN (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
                    FROM pg_enum WHERE enumtypid = t.oid) END AS actual_labels
  FROM expected_enums e
  LEFT JOIN pg_type t ON t.typname = e.name AND t.typtype = 'e'
       AND t.typnamespace = 'public'::regnamespace
 ORDER BY e.name;

-- 2. Row counts (expect 0 everywhere; a non-zero count means real data) --------
WITH names(name) AS (VALUES ('Business'), ('PlaidItem'), ('BankAccount'), ('Category'), ('Rule'), ('BankTransaction'), ('CloverPayment'), ('CloverRefund'), ('Settlement'), ('MonthSnapshot'), ('LoginToken'))
SELECT n.name,
       CASE WHEN to_regclass(format('public.%I', n.name)) IS NULL THEN NULL
            ELSE (xpath('/row/c/text()',
                   query_to_xml(format('SELECT count(*) AS c FROM public.%I', n.name), false, true, '')))[1]::text::bigint
       END AS row_count
  FROM names n
 ORDER BY n.name;

-- 3. _prisma_migrations ---------------------------------------------------------
-- Expected from this run: 0001_init finished; 0002_full_schema failed (finished_at NULL).
-- Checksums are sha256 of the migration.sql files in this repo:
--   0001_init         db998907d02393327ea3295597e764d1dd638685c8b3910ab171bcf08e198146
--   0002_full_schema  7ea168bc092daca503f4d69aacb529b9ac342132a962126d00324611d921173e
-- checksum_matches_yummy = false means a row with that name that is NOT ours.
SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS migrations_table_exists;

SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count,
       checksum = CASE migration_name
                    WHEN '0001_init' THEN 'db998907d02393327ea3295597e764d1dd638685c8b3910ab171bcf08e198146'
                    WHEN '0002_full_schema' THEN '7ea168bc092daca503f4d69aacb529b9ac342132a962126d00324611d921173e' END AS checksum_matches_yummy,
       left(logs, 300) AS logs_head
  FROM public._prisma_migrations
 WHERE migration_name IN ('0001_init', '0002_full_schema')
 ORDER BY started_at;

-- Everything else in the table (REIblast's history; the cleanup must not touch these):
SELECT count(*) AS other_migration_rows FROM public._prisma_migrations
 WHERE migration_name NOT IN ('0001_init', '0002_full_schema');

-- 4. NEVER RAN: all of these should be ABSENT. If present they are not ours. ----
SELECT 'TABLE' AS kind, 'AuditLog' AS name,
       CASE WHEN to_regclass('public."AuditLog"') IS NULL THEN 'ABSENT' ELSE 'EXISTS (not ours)' END AS status
UNION ALL
SELECT 'INDEX', i.n, CASE WHEN to_regclass(format('public.%I', i.n)) IS NULL THEN 'ABSENT' ELSE 'EXISTS (not ours)' END
  FROM unnest(ARRAY['PlaidItem_plaidItemId_key', 'PlaidItem_businessId_idx', 'BankAccount_plaidAccountId_key', 'BankAccount_businessId_idx', 'Category_businessId_section_idx', 'Category_businessId_name_key', 'Rule_businessId_active_priority_idx', 'Rule_businessId_matchType_pattern_key', 'BankTransaction_plaidTransactionId_key', 'BankTransaction_businessId_date_idx', 'BankTransaction_businessId_categoryId_idx', 'BankTransaction_businessId_kind_categoryId_idx', 'CloverPayment_cloverId_key', 'CloverPayment_businessId_createdTime_idx', 'CloverRefund_cloverId_key', 'CloverRefund_businessId_createdTime_idx', 'Settlement_bankTransactionId_key', 'Settlement_businessId_periodEnd_idx', 'MonthSnapshot_businessId_month_key', 'LoginToken_tokenHash_key', 'LoginToken_businessId_email_idx', 'JobRun_businessId_job_period_key', 'AuditLog_businessId_createdAt_idx']) AS i(n)
UNION ALL
SELECT 'FK CONSTRAINT', f.n, CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = f.n) THEN 'EXISTS (not ours)' ELSE 'ABSENT' END
  FROM unnest(ARRAY['PlaidItem_businessId_fkey', 'BankAccount_businessId_fkey', 'BankAccount_plaidItemId_fkey', 'Category_businessId_fkey', 'Rule_businessId_fkey', 'Rule_categoryId_fkey', 'BankTransaction_businessId_fkey', 'BankTransaction_accountId_fkey', 'BankTransaction_categoryId_fkey', 'BankTransaction_ruleId_fkey', 'CloverPayment_businessId_fkey', 'CloverRefund_businessId_fkey', 'CloverRefund_paymentId_fkey', 'Settlement_businessId_fkey', 'Settlement_bankTransactionId_fkey', 'MonthSnapshot_businessId_fkey', 'LoginToken_businessId_fkey', 'JobRun_businessId_fkey', 'AuditLog_businessId_fkey']) AS f(n)
UNION ALL
SELECT 'FUNCTION', p.n, CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = p.n) THEN 'EXISTS (not ours)' ELSE 'ABSENT' END
  FROM unnest(ARRAY['month_snapshot_guard', 'month_snapshot_no_truncate']) AS p(n)
UNION ALL
SELECT 'TRIGGER', g.n, CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = g.n AND NOT tgisinternal) THEN 'EXISTS (not ours)' ELSE 'ABSENT' END
  FROM unnest(ARRAY['month_snapshot_guard_update', 'month_snapshot_guard_delete', 'month_snapshot_guard_truncate']) AS g(n)
 ORDER BY 1, 2;

-- 5. JobRun (REIblast's; catalog metadata only, no rows read) and drop blockers ---
-- JobRun is excluded from the cleanup. This only shows whether its columns differ from Yummy's
-- (Yummy's JobRun was never created). Expect SHAPE_MISMATCH / REIblast's own columns.
SELECT c.relname, (SELECT string_agg(a.attname || ':' || t.typname, ',' ORDER BY a.attname COLLATE "C")
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
       (SELECT string_agg(a.attname || ':' || t.typname, ',' ORDER BY a.attname COLLATE "C")
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) = 'businessId:text,error:text,finishedAt:timestamp,id:text,job:text,period:text,startedAt:timestamp,status:JobStatus' AS looks_like_yummy_jobrun
  FROM pg_class c
 WHERE c.relname = 'JobRun' AND c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace;

-- Any column OUTSIDE the Yummy tables that uses one of the Yummy-named enums (e.g. REIblast's
-- JobRun using a "JobStatus"). If this returns rows for an enum that shows YUMMY_MATCH above,
-- that enum is shared: do NOT drop it. The cleanup also checks this and aborts.
SELECT n.nspname, c.relname AS used_by_table, a.attname AS column_name, t.typname AS enum_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r','p','v','m')
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
 WHERE a.attnum > 0 AND NOT a.attisdropped
   AND t.typname IN ('PlaidItemStatus', 'CategorySection', 'RuleMatchType', 'TransactionKind', 'CategorySource', 'SettlementMatchStatus', 'SnapshotStatus', 'JobStatus')
   AND t.typnamespace = 'public'::regnamespace
   AND NOT (n.nspname = 'public' AND c.relname IN ('Business', 'PlaidItem', 'BankAccount', 'Category', 'Rule', 'BankTransaction', 'CloverPayment', 'CloverRefund', 'Settlement', 'MonthSnapshot', 'LoginToken'))
 ORDER BY 1, 2, 3;

-- Anything (FK, view, other) outside the Yummy tables that depends on a Yummy table:
SELECT DISTINCT cl.relname AS yummy_table, con.conname AS fk_name, con.conrelid::regclass AS referencing_table
  FROM pg_constraint con
  JOIN pg_class cl ON cl.oid = con.confrelid
 WHERE con.contype = 'f' AND cl.relnamespace = 'public'::regnamespace
   AND cl.relname IN ('Business', 'PlaidItem', 'BankAccount', 'Category', 'Rule', 'BankTransaction', 'CloverPayment', 'CloverRefund', 'Settlement', 'MonthSnapshot', 'LoginToken')
   AND NOT (con.conrelid::regclass::text = ANY(ARRAY['Business', 'PlaidItem', 'BankAccount', 'Category', 'Rule', 'BankTransaction', 'CloverPayment', 'CloverRefund', 'Settlement', 'MonthSnapshot', 'LoginToken']));

ROLLBACK;
