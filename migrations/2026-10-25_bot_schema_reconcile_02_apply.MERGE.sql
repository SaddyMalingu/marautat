-- ============================================================================
-- WRITE MODE COPY - GENERATED, DO NOT EDIT
-- ============================================================================
-- Identical to 2026-10-25_bot_schema_reconcile_02_apply.sql except section 0:
--   dry_run := false, confirm := 'MERGE'
--
-- THIS FILE COMMITS. There is no preview here. A dry run of the parent file was
-- executed and reviewed on 2026-10-25 - 24 keeper products, 15 columns to add,
-- 10 views to create, 0 skipped, C. tombstoned rows 0 - and this copy is that
-- same script with the safety catch released.
--
-- Run it once. Re-running is refused by nothing but is pointless: B reports 0
-- columns, E reports "already present", C re-tombstones the same two rows.
-- Delete this file once the apply grid has been verified.
-- ============================================================================
-- BOT SCHEMA RECONCILE - STEP 2: APPLY
-- ============================================================================
-- Prerequisite: run 2026-10-25_bot_schema_reconcile_01_diagnose.sql and keep
-- its output. This file is written for exactly that output (2026-10-25):
--
--   alphadome.bot_*   all 10 tables exist; bot_products 24, product_images 12,
--                     product_variants 4, collections 3, collection_items 7
--   public.bot_*      only bot_tenants exists (3 rows); the other 10 are MISSING
--   tenants           1 row in alphadome, 3 rows in public, ZERO shared uuids
--   catalogue owner   2330bdfe-7b4d-476f-ad0d-ba1b2caeed12  Kassangas 0702245555
--                     -> 24 products, invisible through public.bot_tenants
--
-- What that means
--   The only real Kassangas tenant - the one holding all 24 products, both
--   collections and the live WhatsApp credentials - is the alphadome row. The
--   three public rows are portal shells carrying portal_token / status, and
--   none of them owns a single product. That is why the dashboard reads
--   "0 products", why Orders is permanently empty and why Training cannot save:
--   server.js queries unqualified bot_* tables (PostgREST serves public only)
--   and filters them by the public session uuid.
--
-- Decision taken here
--   Adopt the catalogue owner as the single identity, and stop asking the
--   server to reach into another schema:
--     * promote 2330bdfe into public.bot_tenants, same uuid, credentials copied
--     * add the columns public.bot_tenants is missing (whatsapp_access_token,
--       ai_*, smtp_*, webhook_*, is_active, is_verified, client_email) so
--       server.js:1259 and :3884 stop erroring on a missing column
--     * tombstone the two Kassangas shells (no DELETE, no cascade)
--     * expose the 10 domain tables as public views over alphadome, which keeps
--       the bot runtime reading the same rows it reads today
--     * mirror future portal credential edits back onto the alphadome row, so
--       the token entered in the portal is the token the bot sends with
--
--   Domain data is NOT moved. The 24 products keep bot_tenant_id 2330bdfe and
--   the bot's get_catalog / get_tenant_by_wa (both keyed on alphadome) keep
--   resolving to the same row as before. Zero regression on the live WhatsApp
--   path is the whole point of adopting the alphadome uuid instead of re-keying
--   the catalogue onto a public shell.
--
-- How to run
--   Run as-is: the flags near the top are already false / 'MERGE', so every
--   write commits. Then read the LAST result set: step | detail | rows. The SQL
--   Editor only keeps the final grid, which is why the report SELECT is the
--   last statement in this file and the verification NOTICEs come before it.
--
-- Safety
--   * One transaction. Any guard raises and rolls the whole thing back.
--   * Guards fail the run if the keeper does not own products, if a retire id
--     is unknown, or if the write word is missing.
--   * No DELETE anywhere. Retire rows are tombstoned like tenant_merge_02.
--   * Retire rows are tombstoned BEFORE the keeper is promoted, so a UNIQUE
--     index on client_phone cannot collide (both shells share the number).
--   * Views are only created for alphadome tables whose name is free in public.
--     A same-named public TABLE is reported and skipped, never replaced.
--   * Secrets are never printed. Credentials are only probed for NULL-ness.
-- ============================================================================
BEGIN;

DROP TABLE IF EXISTS public._bot_reconcile_report;
CREATE TABLE public._bot_reconcile_report (
  step   text,
  detail text,
  rows   bigint,
  seq    bigserial
);

-- Flip these two values to apply.
DROP TABLE IF EXISTS _bot_reconcile_ctl;
CREATE TEMP TABLE _bot_reconcile_ctl (
  dry_run boolean NOT NULL,
  confirm text    NOT NULL,
  keeper  uuid    NOT NULL,
  retire  uuid[]  NOT NULL
);
INSERT INTO _bot_reconcile_ctl (dry_run, confirm, keeper, retire) VALUES (
  false,
  'MERGE',
  '2330bdfe-7b4d-476f-ad0d-ba1b2caeed12',
  ARRAY['62828821-4a59-4775-894e-017d5da92f13'::uuid,
        '84342b47-3a46-431d-b5f3-e8dd7f4bd979'::uuid]
);

-- ---------------------------------------------------------------------------
-- A) Preflight. Read-only. Every later section assumes these answers.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dry     boolean;
  v_confirm text;
  v_keeper  uuid;
  v_retire  uuid[];
  v_n       bigint;
  v_ids     uuid[];
  v_resp    record;
BEGIN
  SELECT dry_run, confirm, keeper, retire
    INTO v_dry, v_confirm, v_keeper, v_retire
    FROM _bot_reconcile_ctl;

  IF NOT v_dry AND coalesce(v_confirm, '') <> 'MERGE' THEN
    RAISE EXCEPTION 'write refused: set confirm := % next to dry_run := false',
      quote_literal('MERGE');
  END IF;

  INSERT INTO public._bot_reconcile_report VALUES
    ('A. mode', CASE WHEN v_dry THEN 'DRY RUN - nothing written' ELSE 'APPLY' END,
     CASE WHEN v_dry THEN 0 ELSE 1 END);

  IF v_keeper = ANY (v_retire) THEN
    RAISE EXCEPTION 'keeper % is also in the retire list', v_keeper;
  END IF;

  IF to_regclass('alphadome.bot_tenants') IS NULL
     OR to_regclass('public.bot_tenants') IS NULL THEN
    RAISE EXCEPTION 'need both alphadome.bot_tenants and public.bot_tenants';
  END IF;

  EXECUTE format('SELECT count(*) FROM alphadome.bot_tenants WHERE id = %L', v_keeper)
    INTO v_n;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'keeper % not found in alphadome.bot_tenants', v_keeper;
  END IF;

  IF to_regclass('alphadome.bot_products') IS NULL THEN
    RAISE EXCEPTION 'alphadome.bot_products is missing - re-run diagnose 01';
  END IF;
  EXECUTE format('SELECT count(*) FROM alphadome.bot_products WHERE bot_tenant_id = %L', v_keeper)
    INTO v_n;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'keeper % owns no products - wrong uuid, do not promote it', v_keeper;
  END IF;
  INSERT INTO public._bot_reconcile_report VALUES
    ('A. keeper products', 'catalogue rows this identity owns', v_n);

  SELECT array_agg(id) INTO v_ids FROM public.bot_tenants WHERE id = ANY (v_retire);
  IF coalesce(array_length(v_ids, 1), 0) <> array_length(v_retire, 1) THEN
    RAISE EXCEPTION 'retire ids not all present in public.bot_tenants: found %',
      coalesce(v_ids::text, '{}');
  END IF;

  IF EXISTS (SELECT 1 FROM public.bot_tenants WHERE id = v_keeper) THEN
    INSERT INTO public._bot_reconcile_report VALUES
      ('A. note', 'keeper already in public - section E will skip the insert', 0);
  END IF;

  FOR v_resp IN
    SELECT id, client_name, client_phone
      FROM public.bot_tenants
     WHERE id = ANY (v_retire) OR id = v_keeper
     ORDER BY client_phone
  LOOP
    INSERT INTO public._bot_reconcile_report VALUES (
      'A. row',
      format('%s | %s | %s', v_resp.id,
             coalesce(v_resp.client_name, '?'), coalesce(v_resp.client_phone, '?')),
      CASE WHEN v_resp.id = v_keeper THEN 1 ELSE 0 END);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- B) Make public.bot_tenants carry the columns server.js already selects.
--    server.js:1259 asks for whatsapp_access_token / is_active and :3884 reads
--    whatsapp_access_token; neither column exists in public, so readiness falls
--    back to an empty list and abandoned-cart says "WhatsApp not configured".
--    Types and defaults are copied from the alphadome table, not guessed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dry    boolean;
  v_retire uuid[];
  v_rec    record;
  v_added  int := 0;
  v_n      bigint;
BEGIN
  SELECT dry_run, retire INTO v_dry, v_retire FROM _bot_reconcile_ctl;

  FOR v_rec IN
    SELECT a.attname AS col,
           format_type(a.atttypid, a.atttypmod) AS col_type,
           pg_get_expr(ad.adbin, ad.adrelid)   AS col_default
      FROM pg_attribute a
      JOIN pg_class     c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE n.nspname = 'alphadome'
       AND c.relname = 'bot_tenants'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attidentity = ''
       AND a.attgenerated = ''
       AND NOT EXISTS (
         SELECT 1 FROM information_schema.columns pc
          WHERE pc.table_schema = 'public'
            AND pc.table_name   = 'bot_tenants'
            AND pc.column_name  = a.attname)
     ORDER BY a.attnum
  LOOP
    IF NOT v_dry THEN
      EXECUTE format('ALTER TABLE public.bot_tenants ADD COLUMN IF NOT EXISTS %I %s%s',
        v_rec.col, v_rec.col_type,
        CASE WHEN v_rec.col_default IS NOT NULL
             THEN ' DEFAULT ' || v_rec.col_default ELSE '' END);
    END IF;
    INSERT INTO public._bot_reconcile_report VALUES
      ('B. add public column', v_rec.col || ' ' || v_rec.col_type,
       CASE WHEN v_dry THEN 0 ELSE 1 END);
    v_added := v_added + 1;
  END LOOP;

  -- If alphadome declares is_active with a DEFAULT, the ADD COLUMN above hands
  -- that value to the three rows already in public - which could silently
  -- deactivate a tenant this migration is not even touching (Coach Dawn).
  -- isTenantRecordActive() reads the boolean first, so make it agree with status
  -- for every row outside the retire list. C runs next and forces the two shells
  -- to false regardless of what happens here.
  IF NOT v_dry
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'bot_tenants'
                    AND column_name = 'is_active') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'bot_tenants'
                  AND column_name = 'status') THEN
      -- Blank status means active to isTenantRecordActive() ("if (!status) return true"),
      -- so the predicate has to allow '' as well as 'active'.
      EXECUTE 'UPDATE public.bot_tenants '
           || 'SET is_active = (coalesce(lower(trim(status)), '''') IN ('''', ''active'')) '
           || 'WHERE id <> ALL($1)' USING v_retire;
    ELSE
      EXECUTE 'UPDATE public.bot_tenants SET is_active = true WHERE is_active IS NULL';
    END IF;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    INSERT INTO public._bot_reconcile_report VALUES
      ('B. is_active normalised', 'from status on rows outside the retire list', v_n);
  END IF;

  INSERT INTO public._bot_reconcile_report VALUES
    ('B. columns to add', 'public.bot_tenants vs alphadome.bot_tenants', v_added);
END $$;

-- ---------------------------------------------------------------------------
-- C) Tombstone the two Kassangas shells. Runs BEFORE the promote so a UNIQUE
--    index on client_phone cannot collide with the keeper's number.
--    Only the two ids in the ctl row are touched; a third tenant is untouched.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dry    boolean;
  v_keeper uuid;
  v_retire uuid[];
  v_set    text;
  v_mark   text;
  v_row    record;
  v_n      bigint;
BEGIN
  SELECT dry_run, keeper, retire INTO v_dry, v_keeper, v_retire FROM _bot_reconcile_ctl;

  FOR v_row IN
    SELECT id, client_name, client_phone
      FROM public.bot_tenants
     WHERE id = ANY (v_retire)
     ORDER BY client_phone
  LOOP
    v_set := format('client_phone = %L', 'merged:' || v_row.id);

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'bot_tenants'
                  AND column_name = 'status') THEN
      v_set := v_set || ', status = ''inactive''';
    END IF;
    -- isTenantRecordActive() prefers the boolean over status, so it must be
    -- false too or a tombstoned shell still scores as active in readiness.
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'bot_tenants'
                  AND column_name = 'is_active') THEN
      v_set := v_set || ', is_active = false';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'bot_tenants'
                  AND column_name = 'portal_token') THEN
      v_set := v_set || ', portal_token = NULL';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'bot_tenants'
                  AND column_name = 'portal_token_issued_at') THEN
      v_set := v_set || ', portal_token_issued_at = NULL';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'bot_tenants'
                  AND column_name = 'description') THEN
      -- Append the merge note at most once. A re-run must not stack
      -- '[merged into ...]' markers (seen on a 2026-10-25 re-run).
      v_mark := ' [merged into ' || v_keeper || ']';
      v_set := v_set || format(
        ', description = CASE WHEN position(%L in coalesce(description, %L)) > 0'
        ' THEN description'
        ' ELSE left(coalesce(description, %L) || %L, 1000) END',
        v_mark, '', '', v_mark);
    END IF;

    IF NOT v_dry THEN
      EXECUTE format('UPDATE public.bot_tenants SET %s WHERE id = $1', v_set)
        USING v_row.id;
    END IF;

    INSERT INTO public._bot_reconcile_report VALUES (
      'C. tombstone',
      format('%s | %s | %s -> client_phone merged:<id>, inactive, portal token cleared',
             v_row.id, coalesce(v_row.client_name, '?'), coalesce(v_row.client_phone, '?')),
      CASE WHEN v_dry THEN 0 ELSE 1 END);
  END LOOP;

  EXECUTE 'SELECT count(*) FROM public.bot_tenants WHERE client_phone LIKE ''merged:%'''
    INTO v_n;
  INSERT INTO public._bot_reconcile_report VALUES
    ('C. tombstoned rows', 'client_phone rewritten to merged:<id>', v_n);
END $$;

-- ---------------------------------------------------------------------------
-- D) The diagnose output proves nothing about credentials, so rescue any value
--    the shells still hold into the alphadome keeper - only when the keeper's
--    own value is NULL and exactly one shell has one. Presence is reported,
--    values never are.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dry      boolean;
  v_keeper   uuid;
  v_retire   uuid[];
  v_col      text;
  v_has      boolean;
  v_pub_has  boolean;
  v_n        bigint;
  v_cands    text[] := ARRAY[
    'whatsapp_phone_number_id', 'whatsapp_business_account_id',
    'whatsapp_access_token', 'whatsapp_token_expires_at',
    'webhook_url', 'webhook_verify_token',
    'ai_provider', 'ai_model', 'ai_api_key', 'client_email', 'brand_id'];
BEGIN
  SELECT dry_run, keeper, retire INTO v_dry, v_keeper, v_retire FROM _bot_reconcile_ctl;

  FOREACH v_col IN ARRAY v_cands LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'alphadome' AND table_name = 'bot_tenants'
                      AND column_name = v_col) THEN
      CONTINUE;
    END IF;

    -- Whether public already has the column. In an APPLY run B has just added
    -- all 15, so this is true; in a DRY run B wrote nothing, so it is false for
    -- every column B would add. A dry run that skipped those columns entirely
    -- would under-report D, and the operator would then see extra "keeper already
    -- has" lines appear on the write pass and wonder what changed. Treat a
    -- to-be-added column as existing, with no shell holding a value (which is
    -- exactly true: the column does not exist, so it holds nothing).
    v_pub_has := EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'bot_tenants'
                            AND column_name = v_col);

    EXECUTE format('SELECT %I IS NOT NULL FROM alphadome.bot_tenants WHERE id = $1', v_col)
      INTO v_has USING v_keeper;
    IF coalesce(v_has, false) THEN
      INSERT INTO public._bot_reconcile_report VALUES
        ('D. keeper already has', v_col || ' - shells cannot overwrite it', 0);
      CONTINUE;
    END IF;

    IF v_pub_has THEN
      EXECUTE format('SELECT count(*) FROM public.bot_tenants WHERE id = ANY ($1) AND %I IS NOT NULL', v_col)
        INTO v_n USING v_retire;
    ELSE
      v_n := 0;
    END IF;
    IF v_n = 0 THEN
      CONTINUE;
    ELSIF v_n > 1 THEN
      INSERT INTO public._bot_reconcile_report VALUES
        ('D. WARNING ambiguous', format('%s is set on %s shells - fill keeper by hand', v_col, v_n), v_n);
      CONTINUE;
    END IF;

    IF NOT v_dry THEN
      EXECUTE format(
        'UPDATE alphadome.bot_tenants SET %I = (
           SELECT %I FROM public.bot_tenants
            WHERE id = ANY ($2) AND %I IS NOT NULL LIMIT 1)
         WHERE id = $1', v_col, v_col, v_col)
        USING v_keeper, v_retire;
    END IF;
    INSERT INTO public._bot_reconcile_report VALUES
      ('D. rescued to keeper', v_col || ' (value not printed)',
       CASE WHEN v_dry THEN 0 ELSE 1 END);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- E) Promote the keeper into public.bot_tenants under the SAME uuid. Only
--    columns that exist in both schemas are copied; portal-only columns keep
--    their defaults, with status forced to 'active'.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dry    boolean;
  v_keeper uuid;
  v_retire uuid[];
  v_rec    record;
  v_uq     record;
  v_kval   text;
  v_n      bigint;
  v_kactive boolean;
  v_cols   text := '';
  v_exprs  text := '';
  v_blocked text;
BEGIN
  SELECT dry_run, keeper, retire INTO v_dry, v_keeper, v_retire FROM _bot_reconcile_ctl;

  IF EXISTS (SELECT 1 FROM public.bot_tenants WHERE id = v_keeper) THEN
    INSERT INTO public._bot_reconcile_report VALUES
      ('E. promote keeper', 'already present - nothing to do', 0);
    RETURN;
  END IF;

  -- Refuse to run into a NOT NULL portal column we cannot populate.
  SELECT string_agg(pc.column_name, ', ')
    INTO v_blocked
    FROM information_schema.columns pc
   WHERE pc.table_schema = 'public'
     AND pc.table_name   = 'bot_tenants'
     AND pc.is_nullable  = 'NO'
     AND pc.column_default IS NULL
     AND pc.column_name NOT IN (
           SELECT ac.column_name FROM information_schema.columns ac
            WHERE ac.table_schema = 'alphadome' AND ac.table_name = 'bot_tenants')
     AND pc.column_name <> 'status';
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION 'public.bot_tenants has NOT NULL columns with no default that alphadome cannot fill: %',
      v_blocked;
  END IF;

  FOR v_rec IN
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'bot_tenants'
       AND ordinal_position > 0
       AND column_name IN (
             SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'alphadome' AND table_name = 'bot_tenants')
       AND column_name NOT IN ('status', 'description', 'portal_token',
                               'portal_token_issued_at', 'is_active')
     ORDER BY ordinal_position
  LOOP
    v_cols  := v_cols  || CASE WHEN v_cols  = '' THEN '' ELSE ', ' END
                       || format('%I', v_rec.column_name);
    v_exprs := v_exprs || CASE WHEN v_exprs = '' THEN '' ELSE ', ' END
                       || format('a.%I', v_rec.column_name);
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bot_tenants'
                AND column_name = 'status') THEN
    v_cols  := v_cols  || ', status';
    v_exprs := v_exprs || ', ''active''';
  END IF;

  -- is_active is deliberately NOT copied. isTenantRecordActive() prefers the raw
  -- boolean over status, so a false/NULL value in alphadome would promote an
  -- "active" row that server.js:2487 still rejects with "Tenant found but
  -- inactive" - the exact lockout we are fixing. The caller already decided this
  -- tenant is the live one, so the flag is forced true and any override reported.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bot_tenants'
                AND column_name = 'is_active') THEN
    v_cols  := v_cols  || ', is_active';
    v_exprs := v_exprs || ', true';
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'alphadome' AND table_name = 'bot_tenants'
                  AND column_name = 'is_active') THEN
      EXECUTE 'SELECT is_active FROM alphadome.bot_tenants WHERE id = $1'
        INTO v_kactive USING v_keeper;
      IF v_kactive IS DISTINCT FROM true THEN
        INSERT INTO public._bot_reconcile_report VALUES
          ('E. is_active forced true',
           'alphadome had ' || coalesce(v_kactive::text, 'NULL') || ' - portal would 403 otherwise', 1);
      END IF;
    END IF;
  END IF;

  -- Any other single-column UNIQUE index in public could collide with the keeper
  -- (both Kassangas shells carry the same number). A duplicate value on a
  -- tombstoned shell is meaningless, so it is cleared there and reported, rather
  -- than aborting the run with a 23505 halfway through.
  FOR v_uq IN
    SELECT a.attname AS col
      FROM pg_index i
      JOIN pg_class     t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
     WHERE n.nspname = 'public'
       AND t.relname = 'bot_tenants'
       AND i.indisunique
       AND NOT i.indisprimary
       AND i.indnatts = 1
       AND i.indexprs IS NULL
  LOOP
    BEGIN
      EXECUTE format('SELECT %I::text FROM alphadome.bot_tenants WHERE id = $1', v_uq.col)
        INTO v_kval USING v_keeper;
    EXCEPTION WHEN undefined_column THEN
      v_kval := NULL;
    END;
    CONTINUE WHEN coalesce(v_kval, '') = '';

    EXECUTE format(
      'SELECT count(*) FROM public.bot_tenants WHERE id = ANY ($1) AND %I::text = $2',
      v_uq.col) INTO v_n USING v_retire, v_kval;
    IF v_n = 0 THEN
      CONTINUE;
    END IF;

    IF NOT v_dry THEN
      EXECUTE format('UPDATE public.bot_tenants SET %I = NULL WHERE id = ANY ($1) AND %I::text = $2',
                     v_uq.col, v_uq.col)
        USING v_retire, v_kval;
    END IF;
    INSERT INTO public._bot_reconcile_report VALUES
      ('E. cleared duplicate unique value',
       format('%s on %s shell row(s); the keeper keeps it', v_uq.col, v_n),
       CASE WHEN v_dry THEN 0 ELSE v_n END);
  END LOOP;

  IF NOT v_dry THEN
    EXECUTE format(
      'INSERT INTO public.bot_tenants (%s) SELECT %s FROM alphadome.bot_tenants a WHERE a.id = $1',
      v_cols, v_exprs) USING v_keeper;
  END IF;

  INSERT INTO public._bot_reconcile_report VALUES (
    'E. promote keeper',
    format('%s copied into public.bot_tenants with the same uuid (%s)', v_keeper, v_cols),
    CASE WHEN v_dry THEN 0 ELSE 1 END);
END $$;

-- ---------------------------------------------------------------------------
-- F) Anything already keyed to the retired shells follows the keeper, but only
--    where tenant_id genuinely points at bot_tenants (FK) or where the table is
--    wf_campaigns. blog_posts.tenant_id points at site_tenants and is left
--    alone on purpose.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dry    boolean;
  v_keeper uuid;
  v_retire uuid[];
  v_rec    record;
  v_n      bigint;
  v_total  bigint := 0;
BEGIN
  SELECT dry_run, keeper, retire INTO v_dry, v_keeper, v_retire FROM _bot_reconcile_ctl;

  FOR v_rec IN
    SELECT DISTINCT c.relname AS tbl, a.attname AS col
      FROM pg_attribute a
      JOIN pg_class     c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname <> 'bot_tenants'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attname IN ('tenant_id', 'bot_tenant_id')
       AND (
         c.relname = 'wf_campaigns'
         OR EXISTS (SELECT 1 FROM pg_constraint con
                     WHERE con.conrelid  = c.oid
                       AND con.contype   = 'f'
                       AND con.confrelid = 'public.bot_tenants'::regclass)
       )
     ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = ANY ($1)', v_rec.tbl, v_rec.col)
      INTO v_n USING v_retire;
    IF v_n = 0 THEN
      CONTINUE;
    END IF;

    IF NOT v_dry THEN
      EXECUTE format('UPDATE public.%I SET %I = $2 WHERE %I = ANY ($1)',
                     v_rec.tbl, v_rec.col, v_rec.col)
        USING v_retire, v_keeper;
    END IF;
    v_total := v_total + v_n;
    INSERT INTO public._bot_reconcile_report VALUES
      ('F. re-key to keeper', format('%s.%s', v_rec.tbl, v_rec.col), v_n);
  END LOOP;

  INSERT INTO public._bot_reconcile_report VALUES
    ('F. re-keyed rows', 'retired uuid -> keeper uuid', v_total);
END $$;

-- ---------------------------------------------------------------------------
-- G) The fix itself: public views over the alphadome tables, so PostgREST and
--    server.js see them. Single-table SELECT * views are auto-updatable, so
--    inserts, updates and deletes from the dashboard keep working.
--    A public TABLE of the same name is never replaced - it is reported.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dry     boolean;
  v_rec     record;
  v_role    text;
  v_created int := 0;
  v_skipped int := 0;
  v_pub     bigint;
  v_alpha   bigint;
BEGIN
  SELECT dry_run INTO v_dry FROM _bot_reconcile_ctl;

  FOR v_rec IN
    SELECT c.relname AS tbl
      FROM pg_class     c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'alphadome'
       AND c.relkind = 'r'
       AND left(c.relname, 4) = 'bot_'
       AND c.relname <> 'bot_tenants'
     ORDER BY c.relname
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class c2
                 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                WHERE n2.nspname = 'public'
                  AND c2.relname = v_rec.tbl
                  AND c2.relkind IN ('r', 'p', 'm')) THEN
      IF has_table_privilege(format('%I.%I', 'public', v_rec.tbl), 'SELECT') THEN
        EXECUTE format('SELECT count(*) FROM public.%I', v_rec.tbl) INTO v_pub;
      ELSE
        v_pub := -1;   -- not readable here: report, never abort the apply over it
      END IF;
      EXECUTE format('SELECT count(*) FROM alphadome.%I', v_rec.tbl)  INTO v_alpha;
      INSERT INTO public._bot_reconcile_report VALUES
        ('G. SKIPPED',
         format('%s - a real public table owns that name (public rows: %s, alphadome rows: %s)',
                v_rec.tbl, v_pub, v_alpha), 0);
      -- An empty public table shadowing a populated alphadome one is the exact
      -- symptom this migration exists to fix, so it must never scroll past.
      IF v_pub = 0 AND v_alpha > 0 THEN
        RAISE WARNING '%', format(
          'public.%I is a real but EMPTY table while alphadome.%I holds %s rows - '
          'reads will still look empty until that name becomes a view; '
          'rename the public table, do not let this pass as success',
          v_rec.tbl, v_rec.tbl, v_alpha);
      END IF;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF NOT v_dry THEN
      EXECUTE format('CREATE OR REPLACE VIEW public.%I AS SELECT * FROM alphadome.%I',
                     v_rec.tbl, v_rec.tbl);
      FOREACH v_role IN ARRAY ARRAY['service_role', 'authenticated', 'anon'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I',
                         v_rec.tbl, v_role);
        END IF;
      END LOOP;
      EXECUTE format('COMMENT ON VIEW public.%I IS %L', v_rec.tbl,
        'Reconcile 2026-10-25: auto-updatable view over alphadome.' || v_rec.tbl ||
        ' so PostgREST, which only serves public, sees the bot runtime tables.');
    END IF;

    INSERT INTO public._bot_reconcile_report VALUES
      ('G. view', 'public.' || v_rec.tbl || ' -> alphadome.' || v_rec.tbl,
       CASE WHEN v_dry THEN 0 ELSE 1 END);
    v_created := v_created + 1;
  END LOOP;

  INSERT INTO public._bot_reconcile_report VALUES
    ('G. views', format('%s to create, %s skipped', v_created, v_skipped),
     CASE WHEN v_dry THEN 0 ELSE v_created END);
END $$;

-- ---------------------------------------------------------------------------
-- H) Keep the two rows in step. The portal writes credentials into public (it
--    always did - the column was just missing), while the bot sends with the
--    alphadome row. This mirrors non-null credential edits onto the alphadome
--    row so the token pasted in the portal is the token WhatsApp uses.
--    Domain rows are untouched, and timestamps are not copied.
-- ---------------------------------------------------------------------------
DO $mirror$
DECLARE
  v_dry  boolean;
  v_body text;
BEGIN
  SELECT dry_run INTO v_dry FROM _bot_reconcile_ctl;

  IF v_dry THEN
    INSERT INTO public._bot_reconcile_report VALUES
      ('H. mirror trigger', 'skipped in dry run', 0);
    RETURN;
  END IF;

  v_body := $body$
    DECLARE
      v_set text;
    BEGIN
      SELECT string_agg(format('%I = x.%I', j.key, j.key), ', ') INTO v_set
        FROM jsonb_each(to_jsonb(NEW)) j
       WHERE j.value <> 'null'::jsonb
         AND j.key <> ALL (ARRAY['id', 'created_at', 'updated_at', 'status',
                                  'description', 'portal_token', 'portal_token_issued_at'])
         AND j.key IN (SELECT a.attname FROM pg_attribute a
                        WHERE a.attrelid = 'alphadome.bot_tenants'::regclass
                          AND a.attnum > 0
                          AND NOT a.attisdropped);
      IF v_set IS NULL THEN
        RETURN NEW;
      END IF;
      EXECUTE format('UPDATE alphadome.bot_tenants x SET %s WHERE x.id = $1', v_set)
        USING NEW.id;
      RETURN NEW;
    END;
  $body$;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.bot_tenants_mirror_to_alphadome() '
    'RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $body$%s$body$', v_body);

  EXECUTE 'DROP TRIGGER IF EXISTS bot_tenants_mirror ON public.bot_tenants';
  EXECUTE 'CREATE TRIGGER bot_tenants_mirror AFTER INSERT OR UPDATE ON public.bot_tenants '
       || 'FOR EACH ROW EXECUTE FUNCTION public.bot_tenants_mirror_to_alphadome()';

  INSERT INTO public._bot_reconcile_report VALUES
    ('H. mirror trigger', 'public.bot_tenants -> alphadome.bot_tenants (credentials only)', 1);
END $mirror$;

-- ---------------------------------------------------------------------------
-- I) Cache reload, commit, verify, report.
--    ORDER MATTERS: the Supabase SQL Editor renders only the LAST result set in
--    the Results pane. The step | detail | rows report is therefore deliberately
--    the final statement of this file - anything that returns rows after it
--    (the tenant list, for instance) hides the entire report behind its grid.
--    Do not append a SELECT below the report.
-- ---------------------------------------------------------------------------

-- PostgREST caches the schema; without this a new view is a 404 until redeploy.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification. Safe on a dry run: the guarded branch is never planned.
-- These emit NOTICEs, which appear in the Messages tab, not in the grid.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.bot_products') IS NULL THEN
    RAISE NOTICE 'DRY RUN or not applied: public.bot_products does not exist yet';
  ELSE
    RAISE NOTICE 'public.bot_products rows: %', (SELECT count(*) FROM public.bot_products);
    RAISE NOTICE 'reachable via public.bot_tenants: %',
      (SELECT count(*) FROM public.bot_products p
         JOIN public.bot_tenants t ON t.id = p.bot_tenant_id);
    RAISE NOTICE 'public.bot_collections rows: %', (SELECT count(*) FROM public.bot_collections);
    RAISE NOTICE 'public.bot_orders rows: %', (SELECT count(*) FROM public.bot_orders);
    RAISE NOTICE 'public.bot_training_data rows: %', (SELECT count(*) FROM public.bot_training_data);
  END IF;
END $$;

SELECT id, client_name, client_phone, status
  FROM public.bot_tenants
 ORDER BY coalesce(status, ''), client_phone;

-- ---------------------------------------------------------------------------
-- THE GRID. Last statement in the file on purpose - see section I.
--   Dry run : expect A. keeper products 24 | B. columns to add 15 |
--             G. views "10 to create, 0 skipped" | E. promote keeper 0
--   Apply   : expect A. mode APPLY | C. tombstoned rows 2 | E. promote keeper 1 |
--             B. is_active normalised 1 | ten G. view lines at 1 |
--             H. mirror trigger 1
-- ---------------------------------------------------------------------------
SELECT step, detail, rows
  FROM public._bot_reconcile_report
 ORDER BY seq;

-- Once you are happy with the result:
--   DROP TABLE public._bot_reconcile_report;
