-- Run after schema.sql (Dashboard → SQL Editor)
alter table profiles add column if not exists suspended boolean not null default false;

alter table subscriptions drop constraint if exists subscriptions_source_check;
alter table subscriptions add constraint subscriptions_source_check
  check (source in ('mpesa','activation_code','admin'));

-- Extra admins. The super admin (studysprintke@gmail.com) is hard-coded in the function, NOT stored here,
-- so there is no row that could be deleted to remove him.
create table if not exists admins (
  email text primary key,
  added_by text not null,
  created_at timestamptz not null default now()
);
create table if not exists admin_audit (
  id bigint generated always as identity primary key,
  actor text not null, action text not null, target text, detail text,
  created_at timestamptz not null default now()
);
alter table admins enable row level security;
alter table admin_audit enable row level security;
