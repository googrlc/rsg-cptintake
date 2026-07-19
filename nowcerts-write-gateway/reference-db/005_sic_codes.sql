-- SIC reference (master). 444 codes. Idempotent.
create table if not exists public.sic_codes (
  code text primary key, description text not null, category text, subcategory text,
  market_cap_tier text, industry_trend text, competitive_analysis text, quarterly_update text,
  source text default 'Standard Industrial Classification (SIC) Codes', updated_at timestamptz default now());
