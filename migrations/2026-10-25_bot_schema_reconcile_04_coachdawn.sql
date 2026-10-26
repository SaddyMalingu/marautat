-- ============================================================================
-- COACH DAWN 3.0 - PROMOTE public ROW INTO alphadome (STEP 4)
-- ============================================================================
-- Why
--   public.bot_tenants holds Coach Dawn 3.0 (cfc89b88-...), but alphadome.bot_tenants
--   does not. Two consequences, both silent:
--
--   1. The mirror trigger from _02 section H is
--        UPDATE alphadome.bot_tenants SET <credentials> WHERE id = $1
--      For a tenant with no alphadome row that matches ZERO rows. Credentials typed
--      into the admin UI are accepted, echoed back by the form, and thrown away.
--
--   2. public.get_tenant_by_wa() reads alphadome.bot_tenants only. Coach Dawn is
--      invisible to the phone fallback path until she exists on that side.
--
--   This is _02 section E in reverse: same uuid, same column-intersection trick,
--   same forced active flags. It does NOT delete, does NOT touch other tenants,
--   and does NOT clear any alphadome value - if a value would collide it aborts
--   and names the column instead of guessing.
--
-- What it does
--   A. Preflight (read only): both tables exist, the source row is live, and the
--      row is reported as it stands.
--   B. Normalise client_phone to digits in public when it holds formatting.
--   C. Abort if an alphadome UNIQUE column would collide.
--   D. Abort if alphadome has a NOT NULL column with no default that public
--      cannot fill.
--   E. Insert the row under the same uuid, status/is_active forced active.
--
-- Ordering matters: B runs before E so the alphadome copy receives the normalised
-- phone, and E is last so every guard has already had its say.
--
-- Flags near the top. dry_run = true previews and writes nothing.
-- Set dry_run := false and confirm := 'MERGE' to commit.
--
-- The report is the LAST statement in this file on purpose: the Supabase SQL
-- Editor keeps only the final grid. Do not append a SELECT below it.
-- ============================================================================
BEGIN;

DROP TABLE IF EXISTS public._bot_coachdawn_report;
CREATE TABLE public._bot_coachdawn_report (
  step   text,
  detail text,
  rows   bigint,
  seq    bigserial
);

-- Flip these two values to apply.
DROP TABLE IF EXISTS _bot_coachdawn_ctl;
CREATE TEMP TABLE _bot_coachdawn_ctl (
  dry_run boolean NOT NULL,
  confirm text    NOT NULL,
  tenant  uuid    NOT NULL
);
INSERT INTO _bot_coachdawn_ctl (dry_run, confirm, tenant) VALUES (
  true,
  '',
  'cfc89b88-cc67-4655-ab06-b823b93a73e2'
);


-- ---------------------------------------------------------------------------
-- A) Preflight. Read only. Refuses to promote a tombstone or an unknown uuid.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dry     boolean;
  v_confirm text;
  v_id      uuid;
  v_row     record;
  v_n       bigint;
  v_pid     boolean;
BEGIN
  SELECT dry_run, confirm, tenant INTO v_dry, v_confirm, v_id FROM _bot_coachdawn_ctl;

  IF NOT v_dry AND coalesce(v_confirm, '') <> 'MERGE' THEN
    RAISE EXCEPTION 'write refused: set confirm := % next to dry_run := false',
      quote_literal('MERGE');
  END IF;

  INSERT INTO public._bot_coachdawn_report VALUES
    ('A. mode', CASE WHEN v_dry THEN 'DRY RUN - nothing written' ELSE 'APPLY' END,
     CASE WHEN v_dry THEN 0 ELSE 1 END);

  IF to_regclass('alphadome.bot_tenants') IS NULL
     OR to_regclass('public.bot_tenants') IS NULL THEN
    RAISE EXCEPTION 'need both alphadome.bot_tenants and public.bot_tenants';
  END IF;

  SELECT id, client_name, client_phone, status, is_active
    INTO v_row
    FROM public.bot_tenants
   WHERE id = v_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant % not found in public.bot_tenants - wrong uuid?', v_id;
  END IF;

  -- A tombstoned shell must never be promoted: its phone was rewritten to
  -- merged:<id> precisely so it cannot attract traffic again.
  IF coalesce(v_row.client_phone, '') LIKE 'merged:%' THEN
    RAISE EXCEPTION 'tenant % is tombstoned (client_phone %) - refusing to promote',
      v_id, v_row.client_phone;
  END IF;

  INSERT INTO public._bot_coachdawn_report VALUES (
    'A. source',
    format('%s | %s | status=%s | active=%s',
           v_row.id, coalesce(v_row.client_name, '?'),
           coalesce(v_row.status::text, 'null'),
           coalesce(v_row.is_active::text, 'null')),
    CASE WHEN coalesce(v_row.is_active, false) THEN 1 ELSE 0 END);

  -- whatsapp_phone_number_id is the PRIMARY lookup key (server.js:6195): it
  -- resolves before the phone ever matters. Report it so a missing id is not
  -- mistaken for a phone-format problem.
  SELECT coalesce(whatsapp_phone_number_id, '') <> '' INTO v_pid
    FROM public.bot_tenants WHERE id = v_id;
  INSERT INTO public._bot_coachdawn_report VALUES (
    'A. phone_number_id',
    CASE WHEN v_pid THEN 'set - webhook resolves by id, phone format is fallback only'
         ELSE 'MISSING - webhook must fall back to client_phone, so B decides reachability' END,
    CASE WHEN v_pid THEN 1 ELSE 0 END);

  IF to_regclass('alphadome.bot_products') IS NOT NULL THEN
    EXECUTE format('SELECT count(*) FROM alphadome.bot_products WHERE bot_tenant_id = %L', v_id)
      INTO v_n;
    INSERT INTO public._bot_coachdawn_report VALUES
      ('A. products', 'catalogue rows this identity owns in alphadome', v_n);
  END IF;

  IF EXISTS (SELECT 1 FROM alphadome.bot_tenants WHERE id = v_id) THEN
    INSERT INTO public._bot_coachdawn_report VALUES
      ('A. note', 'already present in alphadome - section E will skip the insert', 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- B) Phone to digits. server.js:6206 matches client_phone with an exact .in()
--    against 254XXXXXXXXX / 0XXXXXXXXX, and get_tenant_by_wa() normalises only
--    its ARGUMENT, never the stored value. So '+254 748 621563' matches neither
--    form and the tenant is invisible on the phone path. Stored as the local
--    0-format the Kassangas keeper already uses.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dry boolean;
  v_id  uuid;
  v_raw text;
  v_dig text;
  v_new text;
  v_n   bigint := 0;
BEGIN
  SELECT dry_run, tenant INTO v_dry, v_id FROM _bot_coachdawn_ctl;
  SELECT client_phone INTO v_raw FROM public.bot_tenants WHERE id = v_id;

  v_dig := regexp_replace(coalesce(v_raw, ''), '\D', '', 'g');
  v_new := CASE
    WHEN v_dig = ''                                      THEN NULL
    WHEN left(v_dig, 3) = '254' AND length(v_dig) = 12    THEN '0' || right(v_dig, 9)
    WHEN length(v_dig) = 9                                THEN '0' || v_dig
    ELSE v_dig
  END;

  IF v_new IS DISTINCT FROM v_raw THEN
    IF NOT v_dry THEN
      UPDATE public.bot_tenants SET client_phone = v_new WHERE id = v_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    END IF;
    INSERT INTO public._bot_coachdawn_report VALUES (
      'B. phone normalised',
      format('%s -> %s', coalesce(v_raw, 'NULL'), coalesce(v_new, 'NULL')), v_n);
  ELSE
    INSERT INTO public._bot_coachdawn_report VALUES
      ('B. phone normalised', 'already digits only - nothing to do', 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- C) Unique-collision guard, alphadome side. Both Kassangas shells carried the
--    same number as the keeper, so duplicate phones are a real pattern here. _02
--    cleared duplicates on the dead SHELLS; that must never happen in alphadome,
--    which is the source of truth - so this aborts and names the column instead.
--    A NULL source value cannot collide, which keeps optional/partial indexes quiet.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_id  uuid;
  v_col record;
  v_n   bigint;
  v_val text;
BEGIN
  SELECT tenant INTO v_id FROM _bot_coachdawn_ctl;

  FOR v_col IN
    SELECT a.attname AS col
      FROM pg_index i
      JOIN pg_class     t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
     WHERE n.nspname = 'alphadome'
       AND t.relname = 'bot_tenants'
       AND i.indisunique
       AND i.indnatts = 1
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM alphadome.bot_tenants x '
      ' WHERE x.id <> $1 AND x.%I IS NOT NULL '
      '   AND x.%I = (SELECT %I FROM public.bot_tenants WHERE id = $1)',
      v_col.col, v_col.col, v_col.col) INTO v_n USING v_id;

    IF v_n > 0 THEN
      EXECUTE format('SELECT %I::text FROM public.bot_tenants WHERE id = $1', v_col.col)
        INTO v_val USING v_id;
      RAISE EXCEPTION
        'alphadome already has a different row with % = % - fix that row first '
        '(values are never rewritten automatically)', v_col.col, v_val;
    END IF;
  END LOOP;

  INSERT INTO public._bot_coachdawn_report VALUES
    ('C. collisions', 'no alphadome unique column is taken by the source row', 0);
END $$;

-- ---------------------------------------------------------------------------
-- D) Fillability guard. If alphadome has a NOT NULL column with no default that
--    public cannot supply, the INSERT would fail with 23502 at the very end of
--    the run - after sections B already committed a phone rewrite. Fail early.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_blocked text;
BEGIN
  SELECT string_agg(ac.column_name, ', ' ORDER BY ac.column_name) INTO v_blocked
    FROM information_schema.columns ac
   WHERE ac.table_schema = 'alphadome'
     AND ac.table_name   = 'bot_tenants'
     AND ac.is_nullable  = 'NO'
     AND ac.column_default IS NULL
     AND ac.column_name NOT IN (
           SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'bot_tenants');

  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION
      'alphadome.bot_tenants requires % with no default and public cannot supply it',
      v_blocked;
  END IF;

  INSERT INTO public._bot_coachdawn_report VALUES
    ('D. fillable', 'every alphadome NOT NULL column can be supplied from public', 1);
END $$;

-- ---------------------------------------------------------------------------
-- E) Insert. Same uuid, so the portal session uuid, the catalogue owner and the
--    WhatsApp identity stay one identity - that is the whole point of _02 E.
--    Columns are the intersection of both tables, minus the ones this migration
--    owns: status/is_active are forced (isTenantRecordActive() reads the boolean
--    first, so a false from the source would re-create the 403 lockout), and
--    portal_* / description are public-only portal state that must not leak into
--    the credential store.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dry    boolean;
  v_id     uuid;
  v_rec    record;
  v_cols   text := '';
  v_exprs  text := '';
  v_c      int  := 0;
  v_n      bigint := 0;
  v_phone  text;
  v_forced text := '';
BEGIN
  SELECT dry_run, tenant INTO v_dry, v_id FROM _bot_coachdawn_ctl;

  IF EXISTS (SELECT 1 FROM alphadome.bot_tenants WHERE id = v_id) THEN
    INSERT INTO public._bot_coachdawn_report VALUES
      ('E. promote', 'already in alphadome - skipped, safe to re-run', 0);
    RETURN;
  END IF;

  FOR v_rec IN
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'bot_tenants'
       AND is_generated = 'NEVER'
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
                       || format('p.%I', v_rec.column_name);
    v_c     := v_c + 1;
  END LOOP;

  -- `status` is public-only on this schema, so the guard is what keeps the
  -- FORCE honest: the report names only the flags alphadome actually has.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'alphadome' AND table_name = 'bot_tenants'
                AND column_name = 'status') THEN
    v_cols   := v_cols  || ', status';
    v_exprs  := v_exprs || ', ''active''';
    v_forced := v_forced || CASE WHEN v_forced = '' THEN '' ELSE '/' END || 'status';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'alphadome' AND table_name = 'bot_tenants'
                AND column_name = 'is_active') THEN
    v_cols   := v_cols  || ', is_active';
    v_exprs  := v_exprs || ', true';
    v_forced := v_forced || CASE WHEN v_forced = '' THEN '' ELSE '/' END || 'is_active';
  END IF;

  IF v_c = 0 OR v_cols = '' THEN
    RAISE EXCEPTION 'public and alphadome bot_tenants share no columns to copy';
  END IF;

  IF v_dry THEN
    INSERT INTO public._bot_coachdawn_report VALUES
      ('E. promote',
       format('DRY RUN - would insert %s shared columns, forced: %s',
              v_c, coalesce(nullif(v_forced, ''), 'none')),
       0);
    RETURN;
  END IF;

  -- OVERRIDING SYSTEM VALUE is a no-op unless alphadome.id is an identity column,
  -- and without it a GENERATED ALWAYS identity would reject the explicit uuid -
  -- which is the one value that must survive this migration intact.
  EXECUTE format(
    'INSERT INTO alphadome.bot_tenants (%s) OVERRIDING SYSTEM VALUE '
    'SELECT %s FROM public.bot_tenants p WHERE p.id = $1',
    v_cols, v_exprs) USING v_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  INSERT INTO public._bot_coachdawn_report VALUES
    ('E. promote',
     format('%s shared columns copied, same uuid, forced: %s',
            v_c, coalesce(nullif(v_forced, ''), 'none')),
     v_n);

  SELECT client_phone INTO v_phone FROM alphadome.bot_tenants WHERE id = v_id;
  INSERT INTO public._bot_coachdawn_report VALUES (
    'E. phone in alphadome',
    coalesce(v_phone, 'NULL') || ' - must equal the public value for the phone lookup',
    CASE WHEN v_phone IS NULL THEN 0 ELSE 1 END);
END $$;

-- PostgREST caches the schema; a new row does not need this, but it costs nothing
-- and keeps the same habit as _02.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification NOTICEs (Messages tab, not the grid).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_id uuid;
  v_n  bigint;
BEGIN
  SELECT tenant INTO v_id FROM _bot_coachdawn_ctl;
  SELECT count(*) INTO v_n FROM alphadome.bot_tenants WHERE id = v_id;
  IF v_n = 1 THEN
    RAISE NOTICE 'OK: % exists in alphadome.bot_tenants - mirror writes will land', v_id;
  ELSE
    RAISE NOTICE 'STILL MISSING: % is not in alphadome.bot_tenants (dry run, or E aborted)', v_id;
  END IF;

  SELECT count(*) INTO v_n
    FROM public.bot_tenants p
    JOIN alphadome.bot_tenants a ON a.id = p.id
   WHERE p.id = v_id AND p.client_phone = a.client_phone;
  RAISE NOTICE 'phone agrees across both schemas: %', v_n;
END $$;

-- ---------------------------------------------------------------------------
-- THE GRID. Last statement in the file on purpose - see the header.
--   Dry run : A. mode DRY RUN | B. phone normalised 0 | C. collisions 0 |
--             D. fillable 1 | E. promote "DRY RUN - would insert N shared columns"
--   Apply   : A. mode APPLY | B. phone normalised 1 (+254 748 621563 -> 0748621563) |
--             C. collisions 0 | D. fillable 1 | E. promote 1 | E. phone in alphadome 1
-- ---------------------------------------------------------------------------
SELECT step, detail, rows
  FROM public._bot_coachdawn_report
 ORDER BY seq;

-- Tidying is optional; the report is recreated on every run.
--   DROP TABLE public._bot_coachdawn_report;
