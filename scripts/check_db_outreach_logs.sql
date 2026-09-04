-- Run this in the Supabase SQL editor.
-- Replace phone digits and since date before running.

-- 1) Detailed log rows (proof evidence)
WITH target_phones AS (
  SELECT *
  FROM (VALUES
    ('254711000000'),
    ('254709219000')
  ) AS t(phone_digits)
),
target_users AS (
  SELECT
    tp.phone_digits,
    u.id AS user_id,
    u.phone AS user_phone
  FROM target_phones tp
  LEFT JOIN public.users u
    ON regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g') = tp.phone_digits
),
conversation_rows AS (
SELECT
  tu.phone_digits,
  tu.user_phone,
  tu.user_id,
  c.id,
  c.created_at,
  c.direction,
  c.message_text,
  c.whatsapp_message_id,
  c.brand_id
FROM target_users tu
LEFT JOIN public.conversations c
  ON c.user_id = tu.user_id
 AND c.created_at >= '2026-07-06T00:00:00Z'
)
SELECT
  phone_digits,
  user_phone,
  user_id,
  id,
  created_at,
  direction,
  message_text,
  whatsapp_message_id,
  brand_id
FROM conversation_rows
ORDER BY phone_digits, created_at DESC;

-- 2) Per-target summary (quick operational view)
WITH target_phones AS (
  SELECT *
  FROM (VALUES
    ('254711000000'),
    ('254709219000')
  ) AS t(phone_digits)
),
target_users AS (
  SELECT
    tp.phone_digits,
    u.id AS user_id,
    u.phone AS user_phone
  FROM target_phones tp
  LEFT JOIN public.users u
    ON regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g') = tp.phone_digits
),
conversation_rows AS (
SELECT
  tu.phone_digits,
  tu.user_phone,
  tu.user_id,
  c.id,
  c.created_at,
  c.direction,
  c.message_text,
  c.whatsapp_message_id,
  c.brand_id
FROM target_users tu
LEFT JOIN public.conversations c
  ON c.user_id = tu.user_id
 AND c.created_at >= '2026-07-06T00:00:00Z'
)
SELECT
  phone_digits,
  max(user_phone) AS user_phone,
  max(user_id::text) AS user_id,
  count(id) FILTER (WHERE id IS NOT NULL) AS total_rows_since,
  count(id) FILTER (WHERE direction IN ('outgoing', 'outbound')) AS outgoing_rows_since,
  count(id) FILTER (WHERE direction IN ('incoming', 'inbound')) AS incoming_rows_since,
  max(created_at) FILTER (WHERE direction IN ('outgoing', 'outbound')) AS last_outgoing_at,
  max(created_at) FILTER (WHERE direction IN ('incoming', 'inbound')) AS last_incoming_at,
  CASE
    WHEN max(user_id::text) IS NULL THEN 'NO_MATCHING_USER'
    WHEN count(id) FILTER (WHERE direction IN ('outgoing', 'outbound')) = 0 THEN 'NO_OUTGOING_LOG'
    WHEN count(id) FILTER (WHERE direction IN ('incoming', 'inbound')) > 0 THEN 'REPLY_DETECTED'
    ELSE 'OUTGOING_ONLY_NO_REPLY_YET'
  END AS status
FROM conversation_rows
GROUP BY phone_digits
ORDER BY phone_digits;

-- 3) Phone presence diagnostics across users/subscriptions
WITH target_phones AS (
  SELECT *
  FROM (VALUES
    ('254711000000'),
    ('254709219000')
  ) AS t(phone_digits)
)
SELECT
  tp.phone_digits,
  u.id AS user_id,
  u.phone AS user_phone,
  s.id AS subscription_id,
  s.user_id AS subscription_user_id,
  s.phone AS subscription_phone,
  s.status AS subscription_status,
  s.created_at AS subscription_created_at
FROM target_phones tp
LEFT JOIN public.users u
  ON regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g') = tp.phone_digits
LEFT JOIN public.subscriptions s
  ON regexp_replace(coalesce(s.phone, ''), '\\D', '', 'g') = tp.phone_digits
ORDER BY tp.phone_digits, s.created_at DESC;

-- 4) Fallback check in tenant message logs (if enabled in this project)
WITH target_phones AS (
  SELECT *
  FROM (VALUES
    ('254711000000'),
    ('254709219000')
  ) AS t(phone_digits)
)
SELECT
  tp.phone_digits,
  bml.id,
  bml.created_at,
  bml.direction,
  bml.user_phone,
  bml.whatsapp_message_id,
  bml.bot_tenant_id,
  left(bml.message_text, 240) AS message_preview
FROM target_phones tp
LEFT JOIN alphadome.bot_message_logs bml
  ON regexp_replace(coalesce(bml.user_phone, ''), '\\D', '', 'g') = tp.phone_digits
 AND bml.created_at >= '2026-07-06T00:00:00Z'
ORDER BY tp.phone_digits, bml.created_at DESC;

-- 5) All users who texted the bot in the last 30 days (coverage view)
WITH inbound AS (
  SELECT
    c.user_id,
    count(*) AS inbound_count_30d,
    min(c.created_at) AS first_inbound_at,
    max(c.created_at) AS last_inbound_at
  FROM public.conversations c
  WHERE c.direction IN ('incoming', 'inbound')
    AND c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
),
outbound AS (
  SELECT
    c.user_id,
    count(*) AS outbound_count_30d,
    max(c.created_at) AS last_outbound_at
  FROM public.conversations c
  WHERE c.direction IN ('outgoing', 'outbound')
    AND c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
)
SELECT
  i.user_id,
  u.phone,
  u.full_name,
  i.inbound_count_30d,
  coalesce(o.outbound_count_30d, 0) AS outbound_count_30d,
  i.first_inbound_at,
  i.last_inbound_at,
  o.last_outbound_at,
  CASE
    WHEN o.last_outbound_at IS NULL THEN 'NEEDS_REPLY'
    WHEN i.last_inbound_at > o.last_outbound_at THEN 'NEEDS_REPLY'
    ELSE 'REPLIED_OR_OUTBOUND_AFTER_INBOUND'
  END AS followup_status
FROM inbound i
LEFT JOIN outbound o ON o.user_id = i.user_id
LEFT JOIN public.users u ON u.id = i.user_id
ORDER BY
  CASE
    WHEN o.last_outbound_at IS NULL THEN 0
    WHEN i.last_inbound_at > o.last_outbound_at THEN 1
    ELSE 2
  END,
  i.last_inbound_at DESC
LIMIT 300;

-- 6) Executive totals for the same 30-day window
WITH inbound_users AS (
  SELECT
    c.user_id,
    max(c.created_at) AS last_inbound_at
  FROM public.conversations c
  WHERE c.direction IN ('incoming', 'inbound')
    AND c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
),
last_outbound AS (
  SELECT
    c.user_id,
    max(c.created_at) AS last_outbound_at
  FROM public.conversations c
  WHERE c.direction IN ('outgoing', 'outbound')
    AND c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
)
SELECT
  count(*) AS users_texted_bot_30d,
  count(*) FILTER (WHERE lo.last_outbound_at IS NULL) AS users_with_no_outbound_reply_30d,
  count(*) FILTER (WHERE lo.last_outbound_at IS NOT NULL AND iu.last_inbound_at > lo.last_outbound_at) AS users_waiting_on_followup_30d,
  count(*) FILTER (WHERE lo.last_outbound_at IS NOT NULL AND iu.last_inbound_at <= lo.last_outbound_at) AS users_already_followed_up_30d
FROM inbound_users iu
LEFT JOIN last_outbound lo ON lo.user_id = iu.user_id;

-- 7) Customer-only engagement (excludes known internal/team numbers)
WITH excluded_phones AS (
  SELECT *
  FROM (VALUES
    ('254117604817'),
    ('254743780542'),
    ('254702245555')
  ) AS t(phone_digits)
),
inbound AS (
  SELECT
    c.user_id,
    count(*) AS inbound_count_30d,
    max(c.created_at) AS last_inbound_at
  FROM public.conversations c
  WHERE c.direction IN ('incoming', 'inbound')
    AND c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
),
outbound AS (
  SELECT
    c.user_id,
    count(*) AS outbound_count_30d,
    max(c.created_at) AS last_outbound_at
  FROM public.conversations c
  WHERE c.direction IN ('outgoing', 'outbound')
    AND c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
),
audience AS (
  SELECT
    i.user_id,
    u.phone,
    u.full_name,
    i.inbound_count_30d,
    coalesce(o.outbound_count_30d, 0) AS outbound_count_30d,
    i.last_inbound_at,
    o.last_outbound_at,
    CASE
      WHEN o.last_outbound_at IS NULL THEN 'NEEDS_REPLY'
      WHEN i.last_inbound_at > o.last_outbound_at THEN 'NEEDS_REPLY'
      ELSE 'REPLIED_OR_OUTBOUND_AFTER_INBOUND'
    END AS followup_status
  FROM inbound i
  LEFT JOIN outbound o ON o.user_id = i.user_id
  LEFT JOIN public.users u ON u.id = i.user_id
  WHERE regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g') NOT IN (SELECT phone_digits FROM excluded_phones)
)
SELECT
  count(*) AS customer_users_texted_bot_30d,
  sum(inbound_count_30d) AS customer_inbound_messages_30d,
  sum(outbound_count_30d) AS customer_outbound_messages_30d,
  count(*) FILTER (WHERE followup_status = 'NEEDS_REPLY') AS customer_users_needing_reply_30d,
  count(*) FILTER (WHERE followup_status = 'REPLIED_OR_OUTBOUND_AFTER_INBOUND') AS customer_users_replied_30d
FROM audience;

-- 8) Customer-only detailed list (most recent first)
WITH excluded_phones AS (
  SELECT *
  FROM (VALUES
    ('254117604817'),
    ('254743780542'),
    ('254702245555')
  ) AS t(phone_digits)
),
inbound AS (
  SELECT
    c.user_id,
    count(*) AS inbound_count_30d,
    min(c.created_at) AS first_inbound_at,
    max(c.created_at) AS last_inbound_at
  FROM public.conversations c
  WHERE c.direction IN ('incoming', 'inbound')
    AND c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
),
outbound AS (
  SELECT
    c.user_id,
    count(*) AS outbound_count_30d,
    max(c.created_at) AS last_outbound_at
  FROM public.conversations c
  WHERE c.direction IN ('outgoing', 'outbound')
    AND c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
)
SELECT
  i.user_id,
  u.phone,
  u.full_name,
  i.inbound_count_30d,
  coalesce(o.outbound_count_30d, 0) AS outbound_count_30d,
  i.first_inbound_at,
  i.last_inbound_at,
  o.last_outbound_at,
  CASE
    WHEN o.last_outbound_at IS NULL THEN 'NEEDS_REPLY'
    WHEN i.last_inbound_at > o.last_outbound_at THEN 'NEEDS_REPLY'
    ELSE 'REPLIED_OR_OUTBOUND_AFTER_INBOUND'
  END AS followup_status
FROM inbound i
LEFT JOIN outbound o ON o.user_id = i.user_id
LEFT JOIN public.users u ON u.id = i.user_id
WHERE regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g') NOT IN (SELECT phone_digits FROM excluded_phones)
ORDER BY i.last_inbound_at DESC
LIMIT 300;

-- 9) Customer freshness buckets (who is going cold)
WITH excluded_phones AS (
  SELECT *
  FROM (VALUES
    ('254117604817'),
    ('254743780542'),
    ('254702245555')
  ) AS t(phone_digits)
),
customer_last_touch AS (
  SELECT
    c.user_id,
    max(c.created_at) FILTER (WHERE c.direction IN ('incoming', 'inbound')) AS last_inbound_at,
    max(c.created_at) FILTER (WHERE c.direction IN ('outgoing', 'outbound')) AS last_outbound_at,
    count(*) FILTER (WHERE c.direction IN ('incoming', 'inbound')) AS inbound_count_30d
  FROM public.conversations c
  WHERE c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
),
customer_enriched AS (
  SELECT
    clt.user_id,
    u.phone,
    u.full_name,
    clt.inbound_count_30d,
    clt.last_inbound_at,
    clt.last_outbound_at,
    now() - clt.last_inbound_at AS time_since_last_inbound
  FROM customer_last_touch clt
  LEFT JOIN public.users u ON u.id = clt.user_id
  WHERE regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g') NOT IN (SELECT phone_digits FROM excluded_phones)
)
SELECT
  count(*) FILTER (WHERE time_since_last_inbound <= interval '24 hours') AS active_0_to_24h,
  count(*) FILTER (WHERE time_since_last_inbound > interval '24 hours' AND time_since_last_inbound <= interval '3 days') AS warm_1_to_3d,
  count(*) FILTER (WHERE time_since_last_inbound > interval '3 days' AND time_since_last_inbound <= interval '7 days') AS cooling_4_to_7d,
  count(*) FILTER (WHERE time_since_last_inbound > interval '7 days') AS dormant_over_7d
FROM customer_enriched;

-- 10) Priority re-engagement list (customer users only)
WITH excluded_phones AS (
  SELECT *
  FROM (VALUES
    ('254117604817'),
    ('254743780542'),
    ('254702245555')
  ) AS t(phone_digits)
),
inbound AS (
  SELECT
    c.user_id,
    count(*) AS inbound_count_30d,
    max(c.created_at) AS last_inbound_at
  FROM public.conversations c
  WHERE c.direction IN ('incoming', 'inbound')
    AND c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
),
outbound AS (
  SELECT
    c.user_id,
    max(c.created_at) AS last_outbound_at
  FROM public.conversations c
  WHERE c.direction IN ('outgoing', 'outbound')
    AND c.created_at >= now() - interval '30 days'
  GROUP BY c.user_id
)
SELECT
  i.user_id,
  u.phone,
  u.full_name,
  i.inbound_count_30d,
  i.last_inbound_at,
  o.last_outbound_at,
  CASE
    WHEN i.last_inbound_at >= now() - interval '24 hours' THEN 'MONITOR'
    WHEN i.last_inbound_at >= now() - interval '3 days' THEN 'SOFT_FOLLOWUP'
    WHEN i.last_inbound_at >= now() - interval '7 days' THEN 'FOLLOWUP_NOW'
    ELSE 'REENGAGE_NOW'
  END AS action_priority
FROM inbound i
LEFT JOIN outbound o ON o.user_id = i.user_id
LEFT JOIN public.users u ON u.id = i.user_id
WHERE regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g') NOT IN (SELECT phone_digits FROM excluded_phones)
ORDER BY
  CASE
    WHEN i.last_inbound_at >= now() - interval '24 hours' THEN 3
    WHEN i.last_inbound_at >= now() - interval '3 days' THEN 2
    WHEN i.last_inbound_at >= now() - interval '7 days' THEN 1
    ELSE 0
  END,
  i.inbound_count_30d DESC,
  i.last_inbound_at ASC;
