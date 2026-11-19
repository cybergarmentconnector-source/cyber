-- Tally Cloud Reporting: schema `tally`
-- Only the API server (direct Postgres connection, DATABASE_URL) reads or writes.
-- RLS is enabled on every table with no policies, and anon/authenticated have no grants.

create schema if not exists tally;

-- ---------------------------------------------------------------- accounts
create table tally.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table tally.users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tally.tenants(id) on delete cascade,
  email text not null,
  name text not null,
  password_hash text not null,
  role text not null check (role in ('owner','viewer'))
);
create unique index users_email_key on tally.users (lower(email));
create index users_tenant_idx on tally.users (tenant_id);

create table tally.sessions (
  token_hash text primary key,
  user_id uuid not null references tally.users(id) on delete cascade,
  expires_at timestamptz not null
);
create index sessions_user_idx on tally.sessions (user_id);
create index sessions_expiry_idx on tally.sessions (expires_at);

create table tally.devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tally.tenants(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  connector_version text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  status jsonb not null default '{}'::jsonb   -- {tally:{ok,message}, pendingRecords}
);
create index devices_tenant_idx on tally.devices (tenant_id);

create table tally.pairing_codes (
  code text primary key check (char_length(code) = 8),
  tenant_id uuid not null references tally.tenants(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- ---------------------------------------------------------------- company data
create table tally.companies (
  id text primary key,
  tenant_id uuid not null references tally.tenants(id) on delete cascade,
  name text not null,
  books_from date,
  fy_start_month int not null default 4 check (fy_start_month between 1 and 12),
  base_currency text not null default 'INR',
  device_id uuid references tally.devices(id) on delete set null,
  last_published_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  last_run_status text,
  first_voucher_date date,
  last_voucher_date date,
  sync_interval_sec int not null default 300,
  data_version text
);
create index companies_tenant_idx on tally.companies (tenant_id);

create table tally.ledgers (
  company_id text not null references tally.companies(id) on delete cascade,
  id text not null,
  name text not null,
  parent_group text,
  primary_group text,
  is_party boolean not null default false,
  is_bill_wise boolean not null default false,
  kind text not null default 'other' check (kind in ('debtor','creditor','other')),
  opening numeric(18,2) not null default 0,
  primary key (company_id, id)
);
create index ledgers_kind_idx on tally.ledgers (company_id, kind);

create table tally.vouchers (
  company_id text not null references tally.companies(id) on delete cascade,
  id text not null,
  date date not null,
  voucher_type text,
  base_type text,
  voucher_number text,
  invoice_number text,
  party_ledger_id text,
  party_name text,
  party_gstin text,
  narration text,
  amount numeric(18,2) not null default 0,
  cancelled boolean not null default false,
  optional boolean not null default false,
  unbalanced boolean not null default false,
  deleted boolean not null default false,
  primary key (company_id, id)
);
create index vouchers_date_idx on tally.vouchers (company_id, date);
create index vouchers_type_date_idx on tally.vouchers (company_id, base_type, date);
create index vouchers_party_date_idx on tally.vouchers (company_id, party_ledger_id, date);
-- live (counted) vouchers only: what every report filters on
create index vouchers_live_idx on tally.vouchers (company_id, base_type, date)
  include (party_ledger_id, amount)
  where not cancelled and not optional and not deleted;

create table tally.voucher_entries (
  company_id text not null,
  voucher_id text not null,
  line int not null,
  ledger_id text,
  ledger_name text,
  amount numeric(18,2) not null,      -- debit positive, credit negative
  role text not null default 'other' check (role in ('party','revenue','tax','charge','bank','other')),
  primary key (company_id, voucher_id, line),
  foreign key (company_id, voucher_id) references tally.vouchers(company_id, id) on delete cascade
);
create index entries_ledger_idx on tally.voucher_entries (company_id, ledger_id);
create index entries_role_idx on tally.voucher_entries (company_id, role, voucher_id);

create table tally.voucher_items (
  company_id text not null,
  voucher_id text not null,
  line int not null,
  item_id text,
  item_name text,
  qty numeric(18,3),
  billed_qty numeric(18,3),
  unit text,
  rate numeric(18,2),
  discount numeric(18,2),
  amount numeric(18,2),
  godown text,
  batch text,
  primary key (company_id, voucher_id, line),
  foreign key (company_id, voucher_id) references tally.vouchers(company_id, id) on delete cascade
);
create index items_item_idx on tally.voucher_items (company_id, item_id);

create table tally.bills (
  company_id text not null references tally.companies(id) on delete cascade,
  ledger_id text not null,
  bill text not null,
  bill_date date not null,
  due_date date,
  original numeric(18,2) not null default 0,
  settled numeric(18,2) not null default 0,
  adjustments numeric(18,2) not null default 0,
  balance numeric(18,2) not null default 0,
  voucher_id text,
  is_opening boolean not null default false,
  is_advance boolean not null default false,
  movements jsonb not null default '[]'::jsonb,
  primary key (company_id, ledger_id, bill, bill_date)
);
create index bills_ledger_idx on tally.bills (company_id, ledger_id);

create table tally.stock_items (
  company_id text not null references tally.companies(id) on delete cascade,
  id text not null,
  name text not null,
  alias text,
  stock_group text,
  category text,
  unit text,
  standard_price numeric(18,2),
  avg_purchase_rate numeric(18,2),
  closing_qty numeric(18,3) not null default 0,
  closing_value numeric(18,2) not null default 0,
  primary key (company_id, id)
);

create table tally.stock_godowns (
  company_id text not null,
  item_id text not null,
  godown text not null,
  qty numeric(18,3) not null default 0,
  primary key (company_id, item_id, godown),
  foreign key (company_id, item_id) references tally.stock_items(company_id, id) on delete cascade
);

create table tally.stock_valuation (
  company_id text not null references tally.companies(id) on delete cascade,
  as_of date not null,
  total_value numeric(18,2) not null,
  primary key (company_id, as_of)
);

create table tally.sync_runs (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references tally.companies(id) on delete cascade,
  device_id uuid references tally.devices(id) on delete set null,
  kind text not null check (kind in ('full','incremental','reconcile')),
  status text not null default 'open' check (status in ('open','committed','failed','expired')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  stats jsonb not null default '{}'::jsonb
);
create index sync_runs_company_idx on tally.sync_runs (company_id, started_at desc);

-- ---------------------------------------------------------------- publish
-- Called when a run commits: bumps data_version and last_published_at.
create or replace function tally.next_data_version(p_company_id text)
returns text
language plpgsql
set search_path = tally, pg_temp
as $$
declare v text;
begin
  v := to_char(clock_timestamp() at time zone 'utc', 'YYYYMMDDHH24MISSMS');
  update companies
     set data_version = v,
         last_published_at = now(),
         last_error = null,
         last_run_status = 'committed'
   where id = p_company_id;
  return v;
end $$;

-- ---------------------------------------------------------------- security
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'tally' loop
    execute format('alter table tally.%I enable row level security', t.tablename);
  end loop;
end $$;

revoke all on schema tally from public, anon, authenticated;
revoke all on all tables in schema tally from public, anon, authenticated;
revoke all on all functions in schema tally from public, anon, authenticated;
alter default privileges in schema tally revoke all on tables from anon, authenticated;
alter default privileges in schema tally revoke all on functions from anon, authenticated;
