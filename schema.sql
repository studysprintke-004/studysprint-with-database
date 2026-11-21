-- StudySprint · Supabase schema. Run once in Dashboard → SQL Editor.
-- Firebase uid (text) is the user key everywhere. RLS is ON with NO policies:
-- browsers can't touch these tables; only the `api` Edge Function (service role) can.

create table if not exists profiles (
  uid text primary key,
  email text not null default '',
  name text not null default 'Student',
  phone text not null default '',
  university text not null default '',
  year text not null default '',
  avatar_url text not null default '',
  free_downloads int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id bigint generated always as identity primary key,
  uid text not null,
  plan_key text not null,
  plan_label text not null,
  days int not null,
  amount int not null,
  source text not null check (source in ('mpesa','activation_code')),
  reference text,                       -- M-Pesa code or activation code
  activated_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists subscriptions_uid_idx on subscriptions (uid, expires_at desc);

create table if not exists mpesa_transactions (
  tx_code text primary key,             -- one row per M-Pesa code, ever
  uid text not null,
  fingerprint text not null,            -- first message text seen (anti-tamper)
  status text not null default 'seen' check (status in ('seen','used')),
  amount int,
  first_seen_at timestamptz not null default now(),
  used_at timestamptz
);

create table if not exists activation_codes (
  code_norm text primary key,           -- e.g. S60K7M2QX
  display text not null,                -- e.g. S60-K7M2QX
  email text not null,                  -- only this account may redeem
  plan_key text not null,
  amount int not null,
  created_at timestamptz not null default now(),
  redeemed_by text,
  redeemed_at timestamptz
);

create table if not exists login_activity (
  id bigint generated always as identity primary key,
  uid text not null, device text, browser text,
  created_at timestamptz not null default now()
);
create index if not exists login_activity_idx on login_activity (uid, created_at desc);

create table if not exists activity_log (
  id bigint generated always as identity primary key,
  uid text not null, icon text, title text, detail text,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_idx on activity_log (uid, created_at desc);

create table if not exists downloads_history (   -- links only; files stay on Google Drive
  uid text not null, link text not null,
  name text, cat text, img text,
  opens int not null default 1,
  last_opened_at timestamptz not null default now(),
  primary key (uid, link)
);

alter table profiles           enable row level security;
alter table subscriptions      enable row level security;
alter table mpesa_transactions enable row level security;
alter table activation_codes   enable row level security;
alter table login_activity     enable row level security;
alter table activity_log       enable row level security;
alter table downloads_history  enable row level security;

-- Profile pictures (public-read bucket; uploads only via the Edge Function)
insert into storage.buckets (id, name, public) values ('avatars','avatars',true)
on conflict (id) do nothing;
