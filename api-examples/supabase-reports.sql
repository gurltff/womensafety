-- SafeCircle India: shared community reports (API.md section 2)
-- Paste into Supabase → SQL Editor → New query, then Run.

create table if not exists public.reports (
  id          text primary key check (char_length(id) <= 40),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  zone_id     text not null check (char_length(zone_id) <= 40),
  sev         text not null check (sev in ('green', 'yellow', 'red')),
  text        text not null check (char_length(text) between 12 and 500),
  cats        text[] not null default '{}' check (cardinality(cats) <= 8),
  tod         text check (tod in ('morning', 'afternoon', 'evening', 'night')),
  created_at  timestamptz not null default now()
);

create index if not exists reports_created_at_idx on public.reports (created_at desc);

-- Row Level Security: the rules that keep the table safe to expose to browsers.
alter table public.reports enable row level security;

-- Anyone using the app can read reports (the app only fetches the last 180 days).
create policy "Reports are readable by everyone"
  on public.reports for select
  using (true);

-- Only signed-in (verified) users can add reports, and only as themselves.
create policy "Signed-in users add their own reports"
  on public.reports for insert to authenticated
  with check (auth.uid() = user_id and created_at <= now() + interval '5 minutes');

-- Users can delete only their own reports.
create policy "Users delete their own reports"
  on public.reports for delete to authenticated
  using (auth.uid() = user_id);

-- No update policy: reports can't be edited after posting.
