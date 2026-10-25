-- ============================================================================
-- DUPLICATE TENANT MERGE - STEP 1: READ-ONLY INVENTORY
-- ============================================================================
-- Why this exists
--   Kassangas exists twice as a tenant row:
--     62828821-4a59-4775-894e-017d5da92f13  Kassangas Music Shop  0702245555
--     84342b47-3a46-431d-b5f3-e8dd7f4bd979  Kassangas             254737245555
--   The first row came from
--   2026-02-06_insert_kassangas_test_tenant_and_products.sql and is the row
--   maintained since (2026-09-25). The second row is the one
--   scripts/update_kassangas_*.sql stamped with the real
--   whatsapp_phone_number_id / WABA id, untouched since 2026-04-27.
--   A portal invite signs into ONE row only, so whichever row we do not merge
--   stays invisible to the client.
--   Those migrations wrote to alphadome.bot_tenants while server.js, utils/* and
--   the portal read unqualified bot_tenants (= public), so this script reports
--   which schema each row actually lives in. The apply script merges public and
--   warns if another schema still holds the pair.
--
-- What this script does
--   Counts, for every table carrying a tenant reference (bot_tenant_id or
--   tenant_id), how many rows hang off each id, plus orphaned rows (NULL
--   tenant). It prints the two tenant rows with every secret masked, plus a
--   duplicate detector you can re-run after the merge.
--   Two extra sections exist because the row count is three, not two:
--     5) every Kassangas row in every schema with the rows attached to it, so
--        you can see whether the catalog/FAQs/settings live on the alphadome
--        row (they were seeded there by the 2025/2026 setup migrations).
--     6) whether public - the schema server.js queries - actually has the
--        tables it asks for. A missing public.bot_products is not an error at
--        runtime, it is a bot that answers without prices.
--   Nothing is written to any application table.
--
-- How to run
--   Supabase SQL editor, service role, whole file at once (the temp table lives
--   for the session). Its output decides the keeper in
--   tenant_merge_02_apply.sql.
--
-- Safety
--   * SELECT / temp table only - no UPDATE, INSERT or DELETE on app tables.
--   * Secrets are reported as booleans, never as values.
-- ============================================================================

-- EDIT the two ids only if you are merging a different pair of tenants.
CREATE TEMP TABLE IF NOT EXISTS _merge_inventory (
  schema_name  text,
  table_name   text,
  column_name  text,
  retire_rows  bigint,
  keeper_rows  bigint,
  orphan_rows  bigint
);

-- Snapshot of the tenant table itself. Server code reads unqualified
-- bot_tenants (public) while older scripts use alphadome.bot_tenants, so the
-- snapshot is taken from every schema that has the table.
CREATE TEMP TABLE IF NOT EXISTS _merge_tenants (
  schema_name  text,
  id           text,
  client_name  text,
  client_phone text,
  row_json     jsonb,
  updated_at   timestamptz
);

TRUNCATE _merge_inventory;
TRUNCATE _merge_tenants;

DO $$
DECLARE
  v_keeper uuid := '62828821-4a59-4775-894e-017d5da92f13';
  v_retire uuid := '84342b47-3a46-431d-b5f3-e8dd7f4bd979';
  r        record;
  n_retire bigint;
  n_keeper bigint;
  n_orphan bigint;
BEGIN
  IF v_keeper = v_retire THEN
    RAISE EXCEPTION 'keeper and retire ids are identical (%)', v_keeper;
  END IF;

  -- Every base table that references a tenant, discovered rather than hardcoded
  -- so a table added later is not silently left behind.
  FOR r IN
    SELECT c.table_schema, c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name   = c.table_name
     WHERE c.column_name IN ('bot_tenant_id', 'tenant_id')
       AND t.table_type = 'BASE TABLE'
       AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
       AND c.table_name <> 'bot_tenants'   -- the tenant table, not a child
     ORDER BY 1, 2
  LOOP
    -- ::text keeps uuid and text tenant columns in one code path.
    EXECUTE format(
      'SELECT count(*) FROM %I.%I WHERE %I::text = $1',
      r.table_schema, r.table_name, r.column_name
    ) INTO n_retire USING v_retire::text;

    EXECUTE format(
      'SELECT count(*) FROM %I.%I WHERE %I::text = $1',
      r.table_schema, r.table_name, r.column_name
    ) INTO n_keeper USING v_keeper::text;

    EXECUTE format(
      'SELECT count(*) FROM %I.%I WHERE %I IS NULL',
      r.table_schema, r.table_name, r.column_name
    ) INTO n_orphan;

    INSERT INTO _merge_inventory
    VALUES (r.table_schema, r.table_name, r.column_name, n_retire, n_keeper, n_orphan);
  END LOOP;

  -- Snapshot the tenant rows from every schema that holds a bot_tenants table,
  -- so the report below works whether the live table is public or alphadome.
  FOR r IN
    SELECT t.table_schema
      FROM information_schema.tables t
     WHERE t.table_name = 'bot_tenants'
       AND t.table_type = 'BASE TABLE'
       AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY 1
  LOOP
    EXECUTE format(
      'INSERT INTO _merge_tenants (schema_name, id, client_name, client_phone, row_json, updated_at)
       SELECT %L, t.id::text, t.client_name::text, t.client_phone::text, to_jsonb(t),
              (to_jsonb(t) ->> ''updated_at'')::timestamptz
         FROM %I.bot_tenants t',
      r.table_schema, r.table_schema);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 1) Where the data actually lives
-- ---------------------------------------------------------------------------
SELECT schema_name, table_name, column_name,
       retire_rows, keeper_rows, orphan_rows,
       (retire_rows + keeper_rows) AS total_attached
  FROM _merge_inventory
 ORDER BY retire_rows DESC, keeper_rows DESC, table_name;

-- ---------------------------------------------------------------------------
-- 2) Where each of the two rows lives (a row in two schemas means the
--    server and the old scripts are reading different tables - fix that first)
-- ---------------------------------------------------------------------------
SELECT schema_name, count(*) AS pair_rows
  FROM _merge_tenants
 WHERE id IN ('62828821-4a59-4775-894e-017d5da92f13',
              '84342b47-3a46-431d-b5f3-e8dd7f4bd979')
 GROUP BY schema_name;

-- ---------------------------------------------------------------------------
-- 3) The two tenant rows, side by side, secrets masked
-- ---------------------------------------------------------------------------
SELECT schema_name, id, client_name, client_phone,
       row_json - 'whatsapp_access_token' - 'ai_api_key' - 'portal_token'
                - 'webhook_verify_token' AS visible_fields,
       (row_json -> 'whatsapp_access_token') IS NOT NULL AS has_whatsapp_token,
       row_json -> 'whatsapp_phone_number_id'       AS whatsapp_phone_number_id,
       row_json -> 'whatsapp_business_account_id'   AS whatsapp_business_account_id,
       (row_json -> 'portal_token') IS NOT NULL     AS has_portal_token,
       updated_at
  FROM _merge_tenants
 WHERE id IN ('62828821-4a59-4775-894e-017d5da92f13',
              '84342b47-3a46-431d-b5f3-e8dd7f4bd979')
 ORDER BY updated_at DESC NULLS LAST;

-- ---------------------------------------------------------------------------
-- 4) Duplicate detector - run again after the merge to prove it is clean.
--    Phones: same number, different spelling (+254 / 0 / spaces).
--    Names: first 8 alphanumerics, which is what catches
--    "Kassangas Music Shop" vs "Kassangas".
-- ---------------------------------------------------------------------------
SELECT 'same normalised phone' AS duplicate_kind,
       regexp_replace(regexp_replace(client_phone, '\D', '', 'g'), '^0', '254') AS duplicate_key,
       count(*) AS rows,
       string_agg(schema_name || ':' || id || ' ' || client_name || ' ' || client_phone, ' | ') AS detail
  FROM _merge_tenants
 GROUP BY 1, 2
HAVING count(*) > 1

UNION ALL

SELECT 'same name prefix' AS duplicate_kind,
       left(lower(regexp_replace(client_name, '[^a-zA-Z0-9]', '', 'g')), 8) AS duplicate_key,
       count(*) AS rows,
       string_agg(schema_name || ':' || id || ' ' || client_name || ' ' || client_phone, ' | ') AS detail
  FROM _merge_tenants
 GROUP BY 1, 2
HAVING count(*) > 1;

-- ---------------------------------------------------------------------------
-- 5) Every Kassangas tenant row, in every schema, with what hangs off it
--    The pair is only part of the story. The 2025/2026 setup migrations
--    (2025-02-06, 2026-02-05, 2026-02-06, 2026-03-02) all wrote the shop into
--    alphadome - products, templates, FAQs, control settings - while server.js
--    reads unqualified tables. So the row that owns the catalog can be one this
--    merge never touches. Whatever this section shows for alphadome has to be
--    reconciled or re-keyed before the catalog is visible to the live bot.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE IF NOT EXISTS _merge_kassangas (
  schema_name  text,
  id           text,
  client_name  text,
  client_phone text,
  is_active    text,
  updated_at   timestamptz
);
CREATE TEMP TABLE IF NOT EXISTS _merge_kassangas_rows (
  schema_name text,
  id          text,
  table_ref   text,
  rows        bigint
);
TRUNCATE _merge_kassangas;
TRUNCATE _merge_kassangas_rows;

INSERT INTO _merge_kassangas
SELECT schema_name, id, client_name, client_phone,
       row_json ->> 'is_active', updated_at
  FROM _merge_tenants
 WHERE id IN ('62828821-4a59-4775-894e-017d5da92f13',
              '84342b47-3a46-431d-b5f3-e8dd7f4bd979')
    OR (client_phone IS NOT NULL
        AND regexp_replace(regexp_replace(client_phone, '\D', '', 'g'), '^0', '254') = '254702245555')
    OR (client_name IS NOT NULL
        AND left(lower(regexp_replace(client_name, '[^a-zA-Z0-9]', '', 'g')), 8) = 'kassanga');

DO $$
DECLARE
  k record;
  r record;
  n bigint;
BEGIN
  FOR k IN SELECT id FROM _merge_kassangas LOOP
    FOR r IN
      SELECT c.table_schema, c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema
         AND t.table_name   = c.table_name
       WHERE c.column_name IN ('bot_tenant_id', 'tenant_id')
         AND t.table_type = 'BASE TABLE'
         AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
         AND c.table_name <> 'bot_tenants'
       ORDER BY 1, 2
    LOOP
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text = $1',
                     r.table_schema, r.table_name, r.column_name)
        INTO n USING k.id;
      IF n > 0 THEN
        INSERT INTO _merge_kassangas_rows
        VALUES (r.table_schema, k.id, r.table_name || '.' || r.column_name, n);
      END IF;
    END LOOP;
  END LOOP;
END $$;

SELECT k.schema_name, k.id, k.client_name, k.client_phone, k.is_active, k.updated_at,
       coalesce(sum(r.rows), 0) AS attached_rows,
       coalesce(string_agg(r.table_ref || '=' || r.rows, ', ' ORDER BY r.table_ref), '-')
         AS attached_detail
  FROM _merge_kassangas k
  LEFT JOIN _merge_kassangas_rows r
         ON r.id = k.id AND r.schema_name = k.schema_name
 GROUP BY k.schema_name, k.id, k.client_name, k.client_phone, k.is_active, k.updated_at
 ORDER BY attached_rows DESC;

-- ---------------------------------------------------------------------------
-- 6) Does the schema the server reads (public) even have the tables it queries?
--    server.js asks for unqualified bot_products / bot_templates /
--    bot_training_data / bot_control_settings. If public lacks them, PostgREST
--    returns a schema-cache error and the calling code degrades silently - the
--    bot answers without a catalog. That reads as "the bot is dumb", not as a
--    missing schema, which is why it is checked explicitly here.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE IF NOT EXISTS _merge_runtime_tables (
  table_name    text,
  exists_public boolean,
  rows_public   bigint
);
TRUNCATE _merge_runtime_tables;

DO $$
DECLARE
  v_names text[] := ARRAY['bot_tenants', 'bot_products', 'bot_product_images',
                          'bot_product_variants', 'bot_collections',
                          'bot_collection_items', 'bot_templates',
                          'bot_training_data', 'bot_control_settings',
                          'bot_message_logs'];
  v_name text;
  v_exists boolean;
  n bigint;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    v_exists := to_regclass('public.' || quote_ident(v_name)) IS NOT NULL;
    n := NULL;
    IF v_exists THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_name) INTO n;
    END IF;
    INSERT INTO _merge_runtime_tables VALUES (v_name, v_exists, n);
  END LOOP;
END $$;

SELECT table_name, exists_public, rows_public,
       CASE WHEN NOT exists_public
              THEN 'MISSING in public: server.js query fails with a schema-cache error'
            WHEN rows_public = 0
              THEN 'exists but empty in public'
            ELSE 'ok'
       END AS note
  FROM _merge_runtime_tables
 ORDER BY exists_public, table_name;

