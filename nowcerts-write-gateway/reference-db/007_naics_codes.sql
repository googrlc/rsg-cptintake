-- NAICS 2022 reference (master), pulled from naics.com API. 2125 codes. Idempotent.
create table if not exists public.naics_codes (
  code text primary key,          -- variable width 2-6 digits (e.g. '11', '111110')
  description text not null, depth int,
  source text default 'NAICS 2022 (via naics.com API)', updated_at timestamptz default now());
