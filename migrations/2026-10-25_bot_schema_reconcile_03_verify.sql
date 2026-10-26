-- ============================================================================
-- BOT SCHEMA RECONCILE - STEP 3: VERIFY (READ ONLY)
-- ============================================================================
-- Why this file exists
--   Step 2 dropped and rebuilt public._bot_reconcile_report, so the grid from the
--   first apply run no longer exists - a second run overwrote it. "E. promote
--   keeper: already present" and "B. columns to add: 0" prove a run committed
--   earlier; they do not prove the end state is right. This file reads the end
--   state directly.
--
--   Nothing here writes, creates or drops. Safe to run any time, any number of
--   times, in the SQL Editor or in psql.
--
-- If it errors with "relation public.bot_products does not exist", section G of
-- the apply never ran - stop and report that, the rest of these checks are moot.
--
-- One result set only: the SQL Editor keeps just the last grid.
-- ============================================================================
SELECT step, detail, rows FROM (

  -- The 10 domain tables must be views in public, and nothing may shadow them
  -- with a real table. bot_tenants is excluded: it is meant to stay a table.
  -- "Shadowing" means a base table whose name exists in alphadome too - a
  -- public-only bot_* table (bot_outputs) shadows nothing and is expected.
  SELECT 1 AS seq, 'V. views'::text AS step,
         format('%s views, %s shadowing base tables in public',
                (SELECT count(*) FROM information_schema.views
                  WHERE table_schema = 'public' AND table_name ~ '^bot_'),
                (SELECT count(*) FROM information_schema.tables t
                  WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
                    AND t.table_name ~ '^bot_' AND t.table_name <> 'bot_tenants'
                    AND EXISTS (SELECT 1 FROM information_schema.tables a
                                 WHERE a.table_schema = 'alphadome'
                                   AND a.table_type   = 'BASE TABLE'
                                   AND a.table_name   = t.table_name))) AS detail,
         (SELECT count(*) FROM information_schema.views
           WHERE table_schema = 'public' AND table_name ~ '^bot_') AS rows

  -- Names them. An unexplained count is useless: a stray bot_* table can be a
  -- harmless leftover (bot_settings) or an empty twin that starves the portal
  -- (bot_products), and only the name tells you which. Emits no row when clean.
  -- Scoped to bot_* on purpose: G only creates bot_* views, so a same-named
  -- non-bot table (public.products vs alphadome.products) shadows nothing here.
  UNION ALL
  SELECT 1, 'V. shadowing table', t.table_name::text, 1
    FROM information_schema.tables t
   WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     AND t.table_name ~ '^bot_' AND t.table_name <> 'bot_tenants'
     AND EXISTS (SELECT 1 FROM information_schema.tables a
                  WHERE a.table_schema = 'alphadome'
                    AND a.table_type   = 'BASE TABLE'
                    AND a.table_name   = t.table_name)

  -- The complement, listed rather than counted so it cannot be mistaken for a
  -- leak. bot_outputs lives here: public-only, no alphadome twin, harmless.
  UNION ALL
  SELECT 1, 'V. public-only table', t.table_name::text, 1
    FROM information_schema.tables t
   WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
     AND t.table_name ~ '^bot_' AND t.table_name <> 'bot_tenants'
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables a
                      WHERE a.table_schema = 'alphadome'
                        AND a.table_type   = 'BASE TABLE'
                        AND a.table_name   = t.table_name)

  -- Single-table SELECT * views must be auto-updatable for portal writes to work.
  UNION ALL
  SELECT 2, 'V. updatable views',
         'views reporting is_updatable = YES (portal writes need this)',
         (SELECT count(*) FROM information_schema.views
           WHERE table_schema = 'public' AND table_name ~ '^bot_'
             AND is_updatable = 'YES')

  -- The catalogue the portal page renders.
  UNION ALL
  SELECT 3, 'V. products',
         'rows visible through public.bot_products',
         (SELECT count(*) FROM public.bot_products)

  -- Reachable = the product's bot_tenant_id resolves to an active tenant, which
  -- is what the portal query joins on. A 24/24 split means nothing is orphaned.
  UNION ALL
  SELECT 4, 'V. reachable',
         'products owned by an active tenant via public.bot_tenants',
         (SELECT count(*) FROM public.bot_products p
            JOIN public.bot_tenants t ON t.id = p.bot_tenant_id
           WHERE coalesce(t.is_active, true))

  -- Collections, images and variants are what make the page look priced and real.
  UNION ALL
  SELECT 5, 'V. supporting rows',
         format('collections %s, images %s, variants %s',
                (SELECT count(*) FROM public.bot_collections),
                (SELECT count(*) FROM public.bot_product_images),
                (SELECT count(*) FROM public.bot_product_variants)),
         (SELECT count(*) FROM public.bot_collections)

  -- Every tenant, so tombstoned shells are visibly tombstoned and the keeper is
  -- visibly the only live Kassangas row.
  UNION ALL
  SELECT 6, 'V. tenant ' || coalesce(nullif(client_name, ''), '<unnamed>'),
         format('%s | %s | status=%s | active=%s | %s',
                id, coalesce(client_phone, 'null'), coalesce(status::text, 'null'),
                coalesce(is_active::text, 'null'),
                CASE WHEN portal_token IS NULL
                     THEN 'portal token MISSING' ELSE 'portal token set' END),
         CASE WHEN is_active THEN 1 ELSE 0 END
    FROM public.bot_tenants

  -- Credentials must be identical on both sides, compared as fingerprints so no
  -- secret is ever printed into a grid or a screenshot.
  UNION ALL
  SELECT 7, 'V. token mirror',
         'tenants whose WhatsApp token matches alphadome (fingerprint compare)',
         (SELECT count(*)
            FROM public.bot_tenants p
            JOIN alphadome.bot_tenants a ON a.id = p.id
           WHERE md5(coalesce(p.whatsapp_access_token, '~none~'))
               = md5(coalesce(a.whatsapp_access_token, '~none~')))

  -- The mirror trigger is what keeps public and alphadome in step on credential
  -- edits from the admin UI. Without it the two drift silently.
  UNION ALL
  SELECT 8, 'V. mirror trigger',
         'enabled triggers on public.bot_tenants (expect the mirror)',
         (SELECT count(*) FROM pg_trigger
           WHERE tgrelid = 'public.bot_tenants'::regclass AND NOT tgisinternal)

  -- Writes that the portal performs. Zero is correct here: these tables are
  -- empty until the portal creates the first order / training example.
  UNION ALL
  SELECT 9, 'V. write targets',
         format('orders %s, training %s, message logs %s',
                (SELECT count(*) FROM public.bot_orders),
                (SELECT count(*) FROM public.bot_training_data),
                (SELECT count(*) FROM public.bot_message_logs)),
         0

  -- Proof that B finished. Counts are NOT compared for equality: public keeps
  -- legacy columns alphadome never had, so 30 vs 26 can be perfectly healthy.
  -- The assertion that matters is the next one.
  UNION ALL
  SELECT 10, 'V. tenant columns',
         format('public %s vs alphadome %s columns (public may hold legacy extras)',
                (SELECT count(*) FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'bot_tenants'),
                (SELECT count(*) FROM information_schema.columns
                  WHERE table_schema = 'alphadome' AND table_name = 'bot_tenants')),
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'bot_tenants')

  -- The real test: every alphadome column must exist in public. A missing one
  -- means the portal cannot read or mirror it, and `_04_coachdawn.sql` cannot
  -- copy the row. Expect detail 'none' and rows 0.
  UNION ALL
  SELECT 11, 'V. missing columns',
         coalesce((SELECT string_agg(column_name, ', ' ORDER BY column_name)
                     FROM information_schema.columns
                    WHERE table_schema = 'alphadome' AND table_name = 'bot_tenants'
                      AND column_name NOT IN (
                            SELECT column_name FROM information_schema.columns
                             WHERE table_schema = 'public'
                               AND table_name = 'bot_tenants')), 'none'),
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'alphadome' AND table_name = 'bot_tenants'
             AND column_name NOT IN (
                   SELECT column_name FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'bot_tenants'))

  -- Live tenants present in public but absent from alphadome. The mirror trigger
  -- UPDATEs alphadome by id, so for these rows it silently matches nothing and
  -- the credentials typed into the admin UI are thrown away. Tombstoned shells
  -- are excluded: they are public-only on purpose.
  UNION ALL
  SELECT 12, 'V. orphans',
         coalesce((SELECT string_agg(coalesce(client_name, id::text), ', ' ORDER BY client_name)
                     FROM public.bot_tenants p
                    WHERE coalesce(p.is_active, true)
                      AND NOT EXISTS (SELECT 1 FROM alphadome.bot_tenants a
                                       WHERE a.id = p.id)), 'none'),
         (SELECT count(*) FROM public.bot_tenants p
           WHERE coalesce(p.is_active, true)
             AND NOT EXISTS (SELECT 1 FROM alphadome.bot_tenants a WHERE a.id = p.id))

) q
ORDER BY seq, detail;
