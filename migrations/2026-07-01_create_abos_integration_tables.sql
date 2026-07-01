-- ABOS integration tables for Alpha 3.0 command and finance ingestion
-- Date: 2026-07-01

create schema if not exists alphadome;

create table if not exists alphadome.abos_workbook_ingestions (
  id uuid primary key default gen_random_uuid(),
  workbook_name text not null,
  workbook_path text not null,
  workbook_version text,
  imported_by text,
  imported_at timestamptz not null default now(),
  status text not null default 'completed',
  rows_processed int not null default 0,
  rows_failed int not null default 0,
  notes text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_abos_ingestions_workbook on alphadome.abos_workbook_ingestions(workbook_name, imported_at desc);

create table if not exists alphadome.abos_kpi_snapshots (
  id uuid primary key default gen_random_uuid(),
  ingestion_id uuid references alphadome.abos_workbook_ingestions(id) on delete set null,
  source_workbook text not null,
  source_sheet text not null,
  metric_name text not null,
  metric_value numeric,
  metric_unit text,
  period_label text,
  recorded_at timestamptz not null default now(),
  tenant_phone text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_abos_kpi_metric on alphadome.abos_kpi_snapshots(metric_name, recorded_at desc);
create index if not exists idx_abos_kpi_tenant on alphadome.abos_kpi_snapshots(tenant_phone, recorded_at desc);

create table if not exists alphadome.abos_pipeline_records (
  id uuid primary key default gen_random_uuid(),
  ingestion_id uuid references alphadome.abos_workbook_ingestions(id) on delete set null,
  source_workbook text not null,
  source_sheet text not null,
  external_id text,
  lead_name text,
  company_name text,
  owner_name text,
  stage text,
  status text,
  amount numeric,
  currency text default 'KES',
  close_date date,
  tenant_phone text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_abos_pipeline_stage on alphadome.abos_pipeline_records(stage, updated_at desc);
create index if not exists idx_abos_pipeline_tenant on alphadome.abos_pipeline_records(tenant_phone, updated_at desc);

create table if not exists alphadome.abos_financial_snapshots (
  id uuid primary key default gen_random_uuid(),
  ingestion_id uuid references alphadome.abos_workbook_ingestions(id) on delete set null,
  source_workbook text not null,
  source_sheet text not null,
  statement_type text not null,
  account_name text not null,
  amount numeric,
  currency text default 'KES',
  period_label text,
  tenant_phone text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_abos_financial_stmt on alphadome.abos_financial_snapshots(statement_type, period_label);

create table if not exists alphadome.abos_risk_register (
  id uuid primary key default gen_random_uuid(),
  ingestion_id uuid references alphadome.abos_workbook_ingestions(id) on delete set null,
  source_workbook text not null,
  source_sheet text not null,
  risk_id text,
  risk_title text not null,
  risk_level text,
  impact text,
  probability text,
  mitigation text,
  owner_name text,
  status text,
  due_date date,
  tenant_phone text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_abos_risk_level on alphadome.abos_risk_register(risk_level, status);

create table if not exists alphadome.abos_founder_trail_entries (
  id uuid primary key default gen_random_uuid(),
  ingestion_id uuid references alphadome.abos_workbook_ingestions(id) on delete set null,
  source_workbook text not null,
  source_sheet text not null,
  activity_slot text not null,
  activity_name text,
  activity_category text,
  resource_used text,
  output_text text,
  money_in_kes numeric default 0,
  money_out_kes numeric default 0,
  net_kes numeric default 0,
  priority_goal text,
  alignment_group text,
  tenant_phone text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_abos_founder_trail_sheet on alphadome.abos_founder_trail_entries(source_sheet, created_at desc);
create index if not exists idx_abos_founder_trail_category on alphadome.abos_founder_trail_entries(activity_category, created_at desc);

-- Trigger for updated_at housekeeping.
create or replace function alphadome.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_abos_pipeline_updated_at on alphadome.abos_pipeline_records;
create trigger trg_abos_pipeline_updated_at
before update on alphadome.abos_pipeline_records
for each row
execute function alphadome.set_updated_at();

drop trigger if exists trg_abos_risk_updated_at on alphadome.abos_risk_register;
create trigger trg_abos_risk_updated_at
before update on alphadome.abos_risk_register
for each row
execute function alphadome.set_updated_at();
