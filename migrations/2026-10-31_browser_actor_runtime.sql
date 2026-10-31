-- Browser Actor Runtime (2026-10-31)
--
-- Two tables, both additive. Nothing here touches an existing table, and the
-- runtime works with neither table present:
--
--   browser_identities        tenant -> MoreLogin profile, the durable binding.
--                             Without a row (and with no BROWSER_ACTOR_PROFILES
--                             entry) a tenant is refused with profile_unmapped,
--                             which is the safe direction: no shared browsers.
--
--   browser_actor_sessions    append-only audit of leases. The live lease lives
--                             in server memory; this table answers "who drove
--                             whose profile, when, and from which agent".
--
-- RLS is enabled with no anon policies: only the service role (which the server
-- already uses) can read or write. Ids stay TEXT because MoreLogin uses 64-bit
-- integers that JSON numbers would silently round.

create extension if not exists "pgcrypto";

create table if not exists public.browser_identities (
  id            uuid primary key default gen_random_uuid(),
  tenant_slug   text        not null unique,
  env_id        text        not null,
  runtime       text        not null default 'local',
  label         text,
  phone_id      text,
  proxy_label   text,
  is_active     boolean     not null default true,
  metadata      jsonb       not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint browser_identities_runtime_check check (runtime in ('local', 'cloud')),
  constraint browser_identities_env_id_check check (env_id ~ '^[0-9]{1,20}$')
);

comment on table public.browser_identities is
  'Tenant -> MoreLogin browser profile. One tenant, one profile. Never shared.';
comment on column public.browser_identities.env_id is
  'MoreLogin envId as a decimal string (64-bit integer).';
comment on column public.browser_identities.runtime is
  'local = profile started on the MoreLogin host; cloud = MoreLogin cloud runtime.';

create index if not exists browser_identities_active_idx
  on public.browser_identities (is_active, tenant_slug);

create table if not exists public.browser_actor_sessions (
  id                   text primary key,
  tenant_slug          text        not null,
  env_id               text        not null,
  runtime              text        not null default 'local',
  actor                text,
  status               text        not null default 'opened',
  provider_debug_port  integer,
  lease_expires_at     timestamptz,
  metadata             jsonb       not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

comment on table public.browser_actor_sessions is
  'Append-only audit of browser leases. Never stores a lease token or a cdpUrl.';
comment on column public.browser_actor_sessions.status is
  'opened | starting | captured | closed.';

create index if not exists browser_actor_sessions_tenant_idx
  on public.browser_actor_sessions (tenant_slug, created_at desc);

create index if not exists browser_actor_sessions_env_idx
  on public.browser_actor_sessions (env_id, created_at desc);

alter table public.browser_identities      enable row level security;
alter table public.browser_actor_sessions  enable row level security;

-- Verification: both statements must return zero rows on a clean apply.
--   select tablename from pg_tables
--    where schemaname = 'public'
--      and tablename in ('browser_identities', 'browser_actor_sessions');
--   select count(*) from public.browser_identities;   -- 0 until an operator maps one

-- Example binding (edit before running):
--   insert into public.browser_identities (tenant_slug, env_id, runtime, label)
--   values ('acme', '1673823102599682', 'local', 'Acme Kenya')
--   on conflict (tenant_slug) do update
--     set env_id = excluded.env_id,
--         runtime = excluded.runtime,
--         label = excluded.label,
--         is_active = true,
--         updated_at = now();
