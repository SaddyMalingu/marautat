-- ============================================================================
-- BOT SCHEMA RECONCILE - STEP 1: DIAGNOSE (read-only)
-- ============================================================================
-- Why this exists
--   The tenant_merge inventory step 6 reported:
--     public.bot_tenants          exists, 3 rows
--     every other bot_* table     MISSING in public
--   Those tables were created as alphadome.bot_* by
--   2025-02-06_add_bot_tenants_schema.sql, 2026-02-06_insert_kassangas_* and
--   2026-03-06_create_bot_orders_table.sql, while server.js queries them
--   unqualified through PostgREST, which only serves public. The queries fail
--   with a schema-cache error and several call sites swallow it, so the
--   dashboard shows an empty catalogue instead of an error, orders return []
--   (server.js:3463) and training inserts have no fallback at all.
--
-- What decides the fix
--   If alphadome's tenant-scoped rows hang off the SAME uuids that live in
--   public.bot_tenants, then public views over the alphadome tables fix reads
--   and writes in one migration.
--   If they hang off different uuids (two separate tenant populations), the
--   views would return nothing and the rows have to be reconciled first.
--   Section C prints that number directly.
--
-- How to run
--   Supabase SQL editor, whole file at once. One result grid, four columns:
--   section, item, detail, n.
--
-- Safety
--   SELECT + temp table only. No writes to any application table, no DDL.
-- ============================================================================

CREATE TEMP TABLE IF NOT EXISTS _diag (
  section text,
  item    text,
  detail  text,
  n       bigint
);
TRUNCATE _diag;

-- ---------------------------------------------------------------------------
-- A) Where every bot_* table actually lives, with its real row count.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_names text[] := ARRAY['bot_tenants', 'bot_products', 'bot_product_images',
                          'bot_product_variants', 'bot_collections',
                          'bot_collection_items', 'bot_templates',
                          'bot_training_data', 'bot_control_settings',
                          'bot_message_logs', 'bot_orders'];
  v_schemas text[] := ARRAY['public', 'alphadome'];
  v_s     text;
  v_n     text;
  v_kind  "char";
  v_rows  bigint;
BEGIN
  FOREACH v_s IN ARRAY v_schemas LOOP
    FOREACH v_n IN ARRAY v_names LOOP
      IF to_regclass(format('%I.%I', v_s, v_n)) IS NULL THEN
        INSERT INTO _diag VALUES ('A. table', v_s || '.' || v_n, 'MISSING', NULL);
      ELSE
        SELECT c.relkind INTO v_kind
          FROM pg_class c
          JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = v_s AND c.relname = v_n;
        EXECUTE format('SELECT count(*) FROM %I.%I', v_s, v_n) INTO v_rows;
        INSERT INTO _diag VALUES (
          'A. table',
          v_s || '.' || v_n,
          CASE v_kind WHEN 'r' THEN 'table'
                      WHEN 'v' THEN 'view'
                      WHEN 'm' THEN 'matview'
                      WHEN 'p' THEN 'partitioned table'
                      ELSE 'relkind=' || coalesce(v_kind::text, '?') END,
          v_rows);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- B) Are public.bot_tenants and alphadome.bot_tenants the same population?
--    "same uuid" is the single fact the fix depends on.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n_pub   bigint;
  n_alpha bigint;
  n_both  bigint;
BEGIN
  IF to_regclass('public.bot_tenants') IS NULL
     OR to_regclass('alphadome.bot_tenants') IS NULL THEN
    INSERT INTO _diag VALUES ('B. tenants', 'schema missing',
      'need both public.bot_tenants and alphadome.bot_tenants to compare', NULL);
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.bot_tenants' INTO n_pub;
  EXECUTE 'SELECT count(*) FROM alphadome.bot_tenants' INTO n_alpha;
  EXECUTE 'SELECT count(*) FROM public.bot_tenants p
             JOIN alphadome.bot_tenants a ON a.id::text = p.id::text' INTO n_both;

  INSERT INTO _diag VALUES ('B. tenants', 'public.bot_tenants rows', 'server.js reads this', n_pub);
  INSERT INTO _diag VALUES ('B. tenants', 'alphadome.bot_tenants rows', 'old migrations wrote this', n_alpha);
  INSERT INTO _diag VALUES ('B. tenants', 'same uuid in both', 'these are the ones a view would serve', n_both);
  INSERT INTO _diag VALUES ('B. tenants', 'only in public', 'would see no catalogue through a view', n_pub - n_both);
  INSERT INTO _diag VALUES ('B. tenants', 'only in alphadome', 'catalogue owner the server cannot see', n_alpha - n_both);
END $$;

-- ---------------------------------------------------------------------------
-- C) For each alphadome bot_* table: how many rows would a public view expose
--    to the tenants the server actually knows about?
--    A low "reachable" number means the catalogue belongs to other tenant uuids.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_names text[] := ARRAY['bot_products', 'bot_product_images',
                          'bot_product_variants', 'bot_collections',
                          'bot_collection_items', 'bot_templates',
                          'bot_training_data', 'bot_control_settings',
                          'bot_message_logs', 'bot_orders'];
  v_n     text;
  v_total bigint;
  v_reach bigint;
  v_has   boolean;
BEGIN
  FOREACH v_n IN ARRAY v_names LOOP
    CONTINUE WHEN to_regclass(format('alphadome.%I', v_n)) IS NULL;
    EXECUTE format('SELECT count(*) FROM alphadome.%I', v_n) INTO v_total;
    INSERT INTO _diag VALUES ('C. reach', 'alphadome.' || v_n, 'total rows', v_total);

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'alphadome' AND table_name = v_n
         AND column_name = 'bot_tenant_id') INTO v_has;

    IF v_has AND to_regclass('public.bot_tenants') IS NOT NULL THEN
      EXECUTE format(
        'SELECT count(*) FROM alphadome.%I x
          WHERE x.bot_tenant_id::text IN (SELECT id::text FROM public.bot_tenants)', v_n)
        INTO v_reach;
      INSERT INTO _diag VALUES ('C. reach', 'alphadome.' || v_n,
        'rows for tenant uuids that exist in public.bot_tenants', v_reach);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- D) Per-tenant view: which alphadome tenants own the catalogue, and whether
--    the server can see each of them through public.bot_tenants.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.bot_tenants') IS NULL
     OR to_regclass('alphadome.bot_tenants') IS NULL
     OR to_regclass('alphadome.bot_products') IS NULL THEN
    INSERT INTO _diag VALUES ('D. per tenant', 'skipped',
      'needs public.bot_tenants, alphadome.bot_tenants and alphadome.bot_products', NULL);
    RETURN;
  END IF;

  INSERT INTO _diag
  SELECT 'D. per tenant',
         a.id::text,
         coalesce(a.client_name, '?') || ' | ' || coalesce(a.client_phone, '?')
           || ' | visible via public.bot_tenants: '
           || CASE WHEN p.id IS NULL THEN 'NO' ELSE 'yes' END,
         pr.cnt
    FROM alphadome.bot_tenants a
    LEFT JOIN public.bot_tenants p ON p.id::text = a.id::text
    LEFT JOIN LATERAL (
      SELECT count(*) AS cnt FROM alphadome.bot_products x WHERE x.bot_tenant_id = a.id
    ) pr ON true
   ORDER BY pr.cnt DESC, a.client_name;
END $$;

-- ---------------------------------------------------------------------------
-- E) Do the RPC fallbacks the server already relies on actually exist?
--    (server.js:3288 get_catalog, 6257 get_templates_by_tenant,
--     6276/2828 get_training_by_tenant, 2339 get_tenant_by_wa,
--     3362 seed_portfolio). Each "MISSING" is a route that degrades to empty.
-- ---------------------------------------------------------------------------
INSERT INTO _diag
SELECT 'E. rpc',
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       'defined in ' || n.nspname,
       NULL
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.proname IN ('get_catalog', 'get_training_by_tenant',
                     'get_templates_by_tenant', 'get_tenant_by_wa',
                     'seed_portfolio', 'get_knowledge_by_tenant')
   AND n.nspname IN ('public', 'alphadome')
 ORDER BY 2;

INSERT INTO _diag
SELECT 'E. rpc', v.want, 'MISSING everywhere', NULL
  FROM (VALUES ('get_catalog'), ('get_training_by_tenant'),
               ('get_templates_by_tenant'), ('get_tenant_by_wa'),
               ('seed_portfolio')) AS v(want)
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = v.want AND n.nspname IN ('public', 'alphadome'));

-- ---------------------------------------------------------------------------
-- F) Column drift on bot_tenants between the two schemas. A view has to match
--    the column list server.js writes to, so show what only one side has.
-- ---------------------------------------------------------------------------
INSERT INTO _diag
SELECT 'F. col diff',
       coalesce(pub.column_name, alp.column_name),
       CASE WHEN pub.column_name IS NULL THEN 'only in alphadome'
            WHEN alp.column_name IS NULL THEN 'only in public'
            ELSE 'both' END,
       NULL
  FROM (SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'bot_tenants') pub
  FULL JOIN (SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'alphadome' AND table_name = 'bot_tenants') alp
    ON alp.column_name = pub.column_name
 WHERE pub.column_name IS NULL OR alp.column_name IS NULL;

-- ---------------------------------------------------------------------------
-- Result: one grid. Paste all of it back.
-- ---------------------------------------------------------------------------
SELECT section, item, detail, n
  FROM _diag
 ORDER BY section, item;
