-- ============================================================================
-- DUPLICATE TENANT MERGE - STEP 2: APPLY
-- ============================================================================
-- Prerequisite: run tenant_merge_01_inventory.sql first and keep its output.
-- The retire id only ever moves rows ONTO the keeper, so the keeper must be the
-- row you intend the client to sign into.
--
-- Recommended direction for Kassangas (reasons in the inventory header):
--   keeper 62828821-4a59-4775-894e-017d5da92f13  Kassangas Music Shop 0702245555
--   retire 84342b47-3a46-431d-b5f3-e8dd7f4bd979  Kassangas           254737245555
-- The keeper keeps Gideon's contact number for the invite link, and the real
-- whatsapp_phone_number_id / WABA id / access token are copied across from the
-- retire row. The whatsapp_phone_tenant_mapping row also follows the keeper, so
-- inbound business messages still land on the merged tenant.
--
-- How to run
--   1. Run as-is. v_dry_run is true, so nothing is written; the report table
--      shows exactly what would move. Check the retire row really is the
--      throwaway one.
--   2. Set v_dry_run := false and v_confirm := 'MERGE', then run again.
--   3. Re-run the inventory: keeper should hold both sets of rows, the retire
--      row should be status=inactive with client_phone 'merged:<id>'.
--
-- Safety
--   * Whole script is one transaction; any failed guard rolls everything back.
--   * Phone guards fail the run if the two ids are not the pair this file was
--     written for, so a copy/paste slip cannot merge the wrong tenants.
--   * No DELETE of a tenant row. The retire row is tombstoned instead, so its
--     history stays auditable and nothing cascade-deletes.
--   * bot_control_settings is UNIQUE per tenant: keeper settings win and the
--     retire duplicate is dropped, which is reported explicitly. Any other
--     single-column UNIQUE tenant index with rows on both sides stops the run
--     and names itself, instead of failing halfway with a 23505.
--   * Target schema is discovered. public wins because server.js, utils/* and the
--     portal read unqualified bot_tenants; a pair that also exists in another
--     schema is reported, not silently ignored.
--   * Inbound routing matches on whatsapp_phone_number_id ordered by updated_at,
--     so when the keeper now holds the same number id the retire row gives it up.
--     A genuinely different second line is kept and flagged.
--   * brand_id history (conversations/messages) is NOT re-pointed: the report
--     prints both brand ids and warns when they differ.
--   * Secrets are never printed; only presence is asserted. The closing queries
--     read a temp snapshot so they work in either schema and it dies with the
--     session rather than leaving credentials in a table.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public._tenant_merge_report (
  step   text,
  detail text,
  rows   bigint,
  at     timestamptz DEFAULT now(),
  seq    bigserial
);
-- now() is transaction time, so every row shares one timestamp; seq keeps the
-- report in the order the script actually did things.
ALTER TABLE public._tenant_merge_report ADD COLUMN IF NOT EXISTS seq bigserial;
TRUNCATE public._tenant_merge_report;

-- Verification snapshot, filled inside the DO block below. A temp table keeps
-- the closing queries schema-agnostic (public vs alphadome bot_tenants).
CREATE TEMP TABLE IF NOT EXISTS _merge_snapshot (
  id           text,
  client_name  text,
  client_phone text,
  row_json     jsonb
);
TRUNCATE _merge_snapshot;

DO $$
DECLARE
  v_keeper uuid := '62828821-4a59-4775-894e-017d5da92f13';
  v_retire uuid := '84342b47-3a46-431d-b5f3-e8dd7f4bd979';

  -- Flip both when the dry run looks right.
  v_dry_run boolean := true;
  v_confirm text    := '';
  v_word    constant text := 'MERGE';

  -- Expected client_phone per id. Protects against swapped ids.
  v_keeper_phone_expected constant text := '0702245555';
  v_retire_phone_expected constant text := '254737245555';

  v_schema text;
  v_found  text[] := '{}';
  v_cols   jsonb;
  v_k_phone text;
  v_r_phone text;
  v_set    text;
  v_cast   text;
  v_unique jsonb;
  v_key    text;
  v_retire_has_token boolean := false;
  v_keeper_has_token boolean := false;
  v_k_brand text;
  v_r_brand text;
  v_k_pnid  text;
  v_r_pnid  text;
  v_shadow_text text;
  shadow   record;
  r        record;
  n        bigint;
  v_total  bigint := 0;
BEGIN
  IF v_keeper = v_retire THEN
    RAISE EXCEPTION 'keeper and retire are the same id (%)', v_keeper;
  END IF;

  IF NOT v_dry_run AND coalesce(v_confirm, '') <> v_word THEN
    RAISE EXCEPTION 'write refused: set v_confirm := % next to v_dry_run := false', quote_literal(v_word);
  END IF;

  -- Which schema holds both rows. server.js reads unqualified bot_tenants
  -- (public) while older scripts use alphadome.bot_tenants, so if BOTH schemas
  -- hold the pair the merge target is ambiguous and this run stops.
  FOR r IN
    SELECT t.table_schema
      FROM information_schema.tables t
     WHERE t.table_name = 'bot_tenants'
       AND t.table_type = 'BASE TABLE'
       AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.bot_tenants WHERE id::text = $1 OR id::text = $2',
                   r.table_schema)
      INTO n USING v_keeper::text, v_retire::text;
    IF n = 2 THEN
      v_found := v_found || r.table_schema::text;
    END IF;
  END LOOP;

  IF coalesce(array_length(v_found, 1), 0) = 0 THEN
    RAISE EXCEPTION 'neither schema holds both % and % - check the ids', v_keeper, v_retire;
  END IF;

  -- server.js, utils/* and the portal all read unqualified bot_tenants, which
  -- resolves to public, so public wins when it holds the pair.
  IF 'public' = ANY (v_found) THEN
    v_schema := 'public';
  ELSE
    v_schema := v_found[1];
  END IF;

  INSERT INTO public._tenant_merge_report VALUES ('target schema', v_schema, 1);
  IF array_length(v_found, 1) > 1 THEN
    INSERT INTO public._tenant_merge_report VALUES (
      'WARNING duplicate pair in other schemas',
      format('merged %s only; these also hold both rows: %s', v_schema,
             array_to_string(v_found, ', ')),
      array_length(v_found, 1));
  END IF;

  -- Kassangas-shaped tenants in OTHER schemas are deliberately left alone: every
  -- schema has its own child tables, so re-pointing across schemas is
  -- meaningless and the foreign key would reject it anyway. This matters because
  -- the 2025/2026 setup migrations wrote the shop, catalog, templates and FAQs
  -- into alphadome while server.js reads public. Without this warning "duplicate
  -- removed" could really mean "one of the two shops removed".
  FOR r IN
    SELECT t.table_schema
      FROM information_schema.tables t
     WHERE t.table_name = 'bot_tenants'
       AND t.table_type = 'BASE TABLE'
       AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
       AND t.table_schema <> v_schema
     ORDER BY 1
  LOOP
    v_shadow_text := NULL;
    FOR shadow IN EXECUTE format(
      'SELECT id::text AS id, client_name::text AS nm, client_phone::text AS ph
         FROM %I.bot_tenants', r.table_schema)
    LOOP
      IF regexp_replace(regexp_replace(coalesce(shadow.ph, ''), '\D', '', 'g'), '^0', '254') = '254702245555'
         OR left(lower(regexp_replace(coalesce(shadow.nm, ''), '[^a-zA-Z0-9]', '', 'g')), 8) = 'kassanga' THEN
        v_shadow_text := concat_ws(' | ', v_shadow_text,
                          shadow.id || ' ' || coalesce(shadow.nm, '?') || ' ' || coalesce(shadow.ph, 'null'));
      END IF;
    END LOOP;
    IF v_shadow_text IS NOT NULL THEN
      INSERT INTO public._tenant_merge_report VALUES (
        'WARNING same tenant in another schema',
        format('%s: %s - not merged (own child tables); inventory section 5 has the counts',
               r.table_schema, v_shadow_text),
        0);
    END IF;
  END LOOP;

  -- server.js reads unqualified bot_products. If the catalog was only ever
  -- seeded into alphadome, the live bot answers without prices and nobody sees
  -- an error, so say it out loud at merge time.
  IF to_regclass('public.bot_products') IS NULL THEN
    INSERT INTO public._tenant_merge_report VALUES (
      'WARNING no public.bot_products',
      'server.js queries unqualified bot_products; a catalog seeded into alphadome stays invisible to the bot',
      0);
  END IF;

  EXECUTE format('SELECT client_phone FROM %I.bot_tenants WHERE id = $1', v_schema)
    INTO v_k_phone USING v_keeper;
  EXECUTE format('SELECT client_phone FROM %I.bot_tenants WHERE id = $1', v_schema)
    INTO v_r_phone USING v_retire;
  IF v_k_phone IS NULL THEN
    RAISE EXCEPTION 'keeper % not found in %', v_keeper, v_schema;
  END IF;
  IF v_k_phone <> v_keeper_phone_expected OR v_r_phone <> v_retire_phone_expected THEN
    RAISE EXCEPTION
      'phone guard failed: keeper=% retire=% (expected % / %). Swap the ids or update the two guard constants.',
      v_k_phone, v_r_phone, v_keeper_phone_expected, v_retire_phone_expected;
  END IF;

  EXECUTE format(
    'SELECT jsonb_object_agg(column_name, data_type) FROM information_schema.columns
      WHERE table_schema = %L AND table_name = %L', v_schema, 'bot_tenants'
  ) INTO v_cols;

  -- Any single-column UNIQUE index on a tenant column (besides control settings,
  -- handled below) would fail halfway through the merge if both rows exist.
  -- Find them up front so the run stops with a name instead of a 23505.
  SELECT coalesce(jsonb_object_agg(ns.nspname || '.' || cl.relname || '.' || att.attname, true),
                  '{}'::jsonb)
    INTO v_unique
    FROM pg_index ix
    JOIN pg_class cl      ON cl.oid = ix.indrelid
    JOIN pg_namespace ns  ON ns.oid = cl.relnamespace
    JOIN pg_attribute att ON att.attrelid = cl.oid AND att.attnum = ix.indkey[0]
   WHERE ix.indisunique
     AND ix.indnatts = 1
     AND att.attname IN ('bot_tenant_id', 'tenant_id')
     AND ns.nspname NOT IN ('pg_catalog', 'information_schema');

  INSERT INTO public._tenant_merge_report VALUES
    ('mode', CASE WHEN v_dry_run THEN 'DRY RUN - nothing written' ELSE 'APPLY' END, 0);

  -- -------------------------------------------------------------------------
  -- 1) Re-point every tenant-scoped table (discovered, not hardcoded)
  -- -------------------------------------------------------------------------
  FOR r IN
    SELECT c.table_schema, c.table_name, c.column_name, c.data_type
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
    v_cast := CASE
                WHEN r.data_type = 'uuid' THEN 'uuid'
                WHEN r.data_type IN ('integer', 'bigint', 'smallint') THEN 'bigint'
                ELSE 'text'
              END;

    -- UNIQUE(bot_tenant_id) on control settings: two rows cannot coexist, and
    -- the keeper's own toggles are the ones the client has been using.
    IF r.table_name = 'bot_control_settings' AND r.column_name = 'bot_tenant_id' THEN
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text = $1',
                     r.table_schema, r.table_name, r.column_name)
        INTO n USING v_keeper::text;
      IF n > 0 THEN
        EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text = $1',
                       r.table_schema, r.table_name, r.column_name)
          INTO n USING v_retire::text;
        INSERT INTO public._tenant_merge_report VALUES (
          'drop duplicate control settings',
          format('%I.%I: keeper settings kept, retire duplicate dropped', r.table_schema, r.table_name),
          n);
        IF NOT v_dry_run AND n > 0 THEN
          EXECUTE format('DELETE FROM %I.%I WHERE %I::text = $1',
                         r.table_schema, r.table_name, r.column_name)
            USING v_retire::text;
        END IF;
        CONTINUE;
      END IF;
    END IF;

    v_key := r.table_schema || '.' || r.table_name || '.' || r.column_name;
    IF jsonb_exists(coalesce(v_unique, '{}'::jsonb), v_key) THEN
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text = $1',
                     r.table_schema, r.table_name, r.column_name)
        INTO n USING v_keeper::text;
      IF n > 0 THEN
        EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text = $1',
                       r.table_schema, r.table_name, r.column_name)
          INTO n USING v_retire::text;
        IF n > 0 THEN
          INSERT INTO public._tenant_merge_report VALUES
            ('UNIQUE conflict needs a decision', v_key, n);
          IF NOT v_dry_run THEN
            RAISE EXCEPTION
              'unique tenant column % has rows for both tenants; merge those rows by hand first', v_key;
          END IF;
          CONTINUE;
        END IF;
      END IF;
    END IF;

    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text = $1',
                   r.table_schema, r.table_name, r.column_name)
      INTO n USING v_retire::text;

    v_total := v_total + n;
    INSERT INTO public._tenant_merge_report VALUES (
      'repoint',
      format('%I.%I.%I', r.table_schema, r.table_name, r.column_name),
      n);

    IF NOT v_dry_run AND n > 0 THEN
      EXECUTE format('UPDATE %I.%I SET %I = $1::%s WHERE %I::text = $2',
                     r.table_schema, r.table_name, r.column_name, v_cast, r.column_name)
        USING v_keeper, v_retire::text;
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 2) Move configuration the keeper is missing (credentials, contact, ids)
  --    Only fields that are NULL/empty on the keeper are filled, so nothing the
  --    client has already configured is overwritten.
  -- -------------------------------------------------------------------------
  FOR r IN
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = v_schema
       AND table_name   = 'bot_tenants'
       AND column_name NOT IN (
         'id', 'client_phone', 'client_name',
         'portal_token', 'portal_token_issued_at', 'webhook_verify_token',
         'status', 'is_active', 'created_at', 'updated_at', 'metadata'
       )
       AND data_type IN ('text', 'character varying', 'uuid', 'numeric',
                         'integer', 'boolean', 'timestamp with time zone')
     ORDER BY column_name
  LOOP
    IF jsonb_exists(v_cols, r.column_name) THEN
      EXECUTE format(
        'UPDATE %I.bot_tenants k
            SET %I = s.%I
           FROM %I.bot_tenants s
          WHERE k.id = $1 AND s.id = $2
            AND (k.%I::text IS NULL OR k.%I::text = '''')
            AND s.%I IS NOT NULL',
        v_schema, r.column_name, r.column_name, v_schema,
        r.column_name, r.column_name, r.column_name
      ) USING v_keeper, v_retire;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN
        INSERT INTO public._tenant_merge_report VALUES
          ('backfill field', r.column_name, n);
      END IF;
    END IF;
  END LOOP;

  IF jsonb_exists(v_cols, 'metadata') THEN
    EXECUTE format(
      'UPDATE %I.bot_tenants k
          SET metadata = coalesce(k.metadata, ''{}''::jsonb)
                       || coalesce(s.metadata, ''{}''::jsonb)
                       || jsonb_build_object(''merged_from'', $2::text, ''merged_at'', now()::text)
         FROM %I.bot_tenants s
        WHERE k.id = $1 AND s.id = $2',
      v_schema, v_schema
    ) USING v_keeper, v_retire;
    INSERT INTO public._tenant_merge_report VALUES
      ('merge metadata', 'keeper metadata tagged merged_from', 1);
  END IF;

  -- The retire row must not be the only place a live WhatsApp credential lives.
  EXECUTE format(
    'SELECT coalesce(to_jsonb(s) ->> ''whatsapp_access_token'', '''') <> ''''
       FROM %I.bot_tenants s WHERE s.id = $1', v_schema)
    INTO v_retire_has_token USING v_retire;
  EXECUTE format(
    'SELECT coalesce(to_jsonb(s) ->> ''whatsapp_access_token'', '''') <> ''''
       FROM %I.bot_tenants s WHERE s.id = $1', v_schema)
    INTO v_keeper_has_token USING v_keeper;

  IF v_retire_has_token AND NOT v_keeper_has_token THEN
    RAISE EXCEPTION
      'aborting: retire % holds a whatsapp_access_token but keeper % still has none - credential copy did not run',
      v_retire, v_keeper;
  END IF;
  IF v_retire_has_token THEN
    INSERT INTO public._tenant_merge_report VALUES
      ('credentials verified', 'keeper now holds the WhatsApp access token', 1);
  END IF;

  -- brand_id decides which conversations/invoices a tenant sees. Merging the
  -- tenant row does NOT move brand-scoped history, so surface both ids.
  IF jsonb_exists(v_cols, 'brand_id') THEN
    EXECUTE format('SELECT to_jsonb(s) ->> ''brand_id'' FROM %I.bot_tenants s WHERE s.id = $1', v_schema)
      INTO v_k_brand USING v_keeper;
    EXECUTE format('SELECT to_jsonb(s) ->> ''brand_id'' FROM %I.bot_tenants s WHERE s.id = $1', v_schema)
      INTO v_r_brand USING v_retire;

    INSERT INTO public._tenant_merge_report VALUES (
      'brand_id',
      format('keeper=%s retire=%s', coalesce(v_k_brand, 'null'), coalesce(v_r_brand, 'null')),
      1);

    IF coalesce(v_r_brand, '') <> '' AND v_k_brand IS DISTINCT FROM v_r_brand THEN
      INSERT INTO public._tenant_merge_report VALUES (
        'WARNING brand-scoped history',
        'conversations/messages kept under the retire brand_id are NOT re-pointed by this merge',
        1);
    END IF;
  END IF;

  -- -------------------------------------------------------------------------
  -- 3) Tombstone the retire row (never DELETE - that would cascade its history)
  -- -------------------------------------------------------------------------
  v_set := 'client_phone = ''merged:'' || id::text';
  IF jsonb_exists(v_cols, 'status')                THEN v_set := v_set || ', status = ''inactive'''; END IF;
  IF jsonb_exists(v_cols, 'is_active')             THEN v_set := v_set || ', is_active = false'; END IF;
  IF jsonb_exists(v_cols, 'is_verified')           THEN v_set := v_set || ', is_verified = false'; END IF;
  IF jsonb_exists(v_cols, 'portal_token')          THEN v_set := v_set || ', portal_token = NULL'; END IF;
  IF jsonb_exists(v_cols, 'portal_token_issued_at') THEN v_set := v_set || ', portal_token_issued_at = NULL'; END IF;
  IF jsonb_exists(v_cols, 'webhook_verify_token')  THEN v_set := v_set || ', webhook_verify_token = NULL'; END IF;
  IF jsonb_exists(v_cols, 'whatsapp_access_token') THEN v_set := v_set || ', whatsapp_access_token = NULL'; END IF;
  IF jsonb_exists(v_cols, 'updated_at')            THEN v_set := v_set || ', updated_at = now()'; END IF;

  -- Inbound routing matches on whatsapp_phone_number_id and orders by
  -- updated_at, and resolveCampaignBrandAndTenant ignores active status. If the
  -- keeper now holds the same number id, leaving it on the tombstone makes the
  -- newest row the dead one, so clear it. A *different* number id is a real
  -- second line and is left alone with a warning.
  IF jsonb_exists(v_cols, 'whatsapp_phone_number_id') THEN
    EXECUTE format('SELECT to_jsonb(s) ->> ''whatsapp_phone_number_id'' FROM %I.bot_tenants s WHERE s.id = $1', v_schema)
      INTO v_k_pnid USING v_keeper;
    EXECUTE format('SELECT to_jsonb(s) ->> ''whatsapp_phone_number_id'' FROM %I.bot_tenants s WHERE s.id = $1', v_schema)
      INTO v_r_pnid USING v_retire;

    IF coalesce(v_r_pnid, '') <> '' THEN
      IF v_k_pnid = v_r_pnid THEN
        v_set := v_set || ', whatsapp_phone_number_id = NULL';
        INSERT INTO public._tenant_merge_report VALUES
          ('clear duplicate phone number id', v_r_pnid || ' now only on the keeper', 1);
      ELSE
        INSERT INTO public._tenant_merge_report VALUES (
          'WARNING retire keeps a different phone number id',
          format('keeper=%s retire=%s - keep both only if it is a second real line',
                 coalesce(v_k_pnid, 'null'), v_r_pnid),
          1);
      END IF;
    END IF;
  END IF;

  IF NOT v_dry_run THEN
    EXECUTE format('UPDATE %I.bot_tenants SET %s WHERE id = $1', v_schema, v_set)
      USING v_retire;
  END IF;
  INSERT INTO public._tenant_merge_report VALUES
    ('tombstone retire row', format('client_phone := ''merged:<id>'', inactive, secrets cleared (%s)', v_retire), 1);

  INSERT INTO public._tenant_merge_report VALUES
    ('total rows repointed', 'sum across every tenant-scoped table', v_total);

  -- Snapshot the merged rows for the verification queries below.
  EXECUTE format(
    'INSERT INTO _merge_snapshot
     SELECT id::text, client_name::text, client_phone::text, to_jsonb(t)
       FROM %I.bot_tenants t
      WHERE client_name ILIKE ''%%kassangas%%'' OR id::text IN ($1, $2)',
    v_schema
  ) USING v_keeper::text, v_retire::text;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- 4) What happened / what would happen
-- ---------------------------------------------------------------------------
SELECT step, detail, rows FROM public._tenant_merge_report ORDER BY seq;

-- Post-merge shape of the merged tenant, secrets masked.
SELECT id, client_name, client_phone,
       row_json ->> 'status'    AS status,
       row_json ->> 'is_active' AS is_active,
       row_json - 'whatsapp_access_token' - 'ai_api_key' - 'portal_token'
                - 'webhook_verify_token' AS visible_fields,
       (row_json -> 'whatsapp_access_token') IS NOT NULL AS has_whatsapp_token
  FROM _merge_snapshot
 WHERE id = '62828821-4a59-4775-894e-017d5da92f13';

-- Nothing should point at the tombstone any more.
SELECT 'Kassangas rows after merge' AS check,
       string_agg(id || ' | ' || client_name || ' | ' || client_phone
                  || ' | ' || coalesce(row_json ->> 'status', '?'), E'\n') AS detail
  FROM _merge_snapshot;
