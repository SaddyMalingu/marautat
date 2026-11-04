-- Duplicate offers, by tenant (2026-11-03)
--
-- READ ONLY. Nothing here changes data — it answers one question: "did collection ever create
-- the same role twice?" Run it after a capture, or whenever that doubt appears.
--
-- Three keys can identify a duplicate, and they mean different things:
--   * the same marketplace listing  → same external_id  (a real duplicate: one role, two offers)
--   * the same role in one catalogue → same slug         (should be impossible: slug is UNIQUE)
--   * the same title                 → same title_key    (a duplicate, unless two marketplaces
--                                                        list the same role — then it is two
--                                                        offers with two different links, which
--                                                        is correct and the marketplace filter
--                                                        separates them)
--
-- A soft-deleted row still counts here, because "it exists" is what stops a re-capture from
-- creating a second copy.

-- 1. The real duplicates: one marketplace listing, more than one offer.
SELECT
  tenant_id,
  external_id,
  count(*)                              AS copies,
  array_agg(slug ORDER BY created_at)   AS slugs,
  array_agg(status ORDER BY created_at) AS statuses
FROM public.opportunities
WHERE external_id IS NOT NULL
GROUP BY tenant_id, external_id
HAVING count(*) > 1
ORDER BY copies DESC, tenant_id;

-- 2. Should always return zero rows: `opportunities.slug` is UNIQUE.
SELECT slug, count(*) AS copies
FROM public.opportunities
GROUP BY slug
HAVING count(*) > 1;

-- 3. The same role title twice within one source. Rows under different marketplaces are
--    expected and correct; anything else is a duplicate.
SELECT
  o.tenant_id,
  lower(btrim(o.title))  AS title_key,
  coalesce(s.slug, '(unsourced)') AS marketplace,
  count(*)               AS copies,
  array_agg(o.slug ORDER BY o.created_at) AS slugs
FROM public.opportunities o
LEFT JOIN public.opportunity_sources s ON s.id = o.source_id
GROUP BY o.tenant_id, lower(btrim(o.title)), coalesce(s.slug, '(unsourced)')
HAVING count(*) > 1
ORDER BY copies DESC, title_key;

-- 4. Attribution, now that the source rows exist: offers with no source at all.
SELECT coalesce(s.slug, '(unsourced)') AS marketplace, count(*) AS offers
FROM public.opportunities o
LEFT JOIN public.opportunity_sources s ON s.id = o.source_id
GROUP BY coalesce(s.slug, '(unsourced)')
ORDER BY offers DESC;
