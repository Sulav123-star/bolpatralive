-- Run this once in the Supabase SQL editor (or via migration)

create table if not exists bolpatra_notices (
  id uuid primary key default gen_random_uuid(),
  tender_ref text unique not null,          -- e.g. "BPKMCH/ICB/01/082/083"
  title text not null,
  public_entity text,
  procurement_type text,                    -- Goods / Works / Services
  status text,                              -- ICB / NCB / Sealed Quotation etc.
  notice_published_date text,               -- kept as text: source format is "DD-MM-YYYY HH:MM"
  bid_submission_date text,
  days_left integer,
  source_url text,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bolpatra_first_seen on bolpatra_notices (first_seen_at desc);

-- Auto-update `updated_at` on every upsert
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_bolpatra_updated_at on bolpatra_notices;
create trigger trg_bolpatra_updated_at
  before update on bolpatra_notices
  for each row execute function set_updated_at();

-- Health/monitoring log for the sync job
create table if not exists sync_log (
  id uuid primary key default gen_random_uuid(),
  source text not null,                     -- 'bolpatra'
  status text not null,                     -- 'success' | 'error'
  rows_synced integer,
  new_rows integer,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_sync_log_source_created on sync_log (source, created_at desc);
