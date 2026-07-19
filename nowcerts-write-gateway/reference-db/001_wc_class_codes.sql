-- Workers' Comp class-code reference table (master of record).
-- Source: Workers Compensation Classification Codes (Manual DN0059). 423 codes.
-- Apply via Supabase: create table, then seed. Idempotent (safe to re-run).
-- The gateway reads a cached snapshot (src/reference/wc-class-codes.json); to
-- refresh that snapshot from this master, dump the table back to that file.

create table if not exists public.wc_class_codes (
  code                text primary key,        -- NCCI canonical 4-digit, e.g. '0042'
  description         text not null,
  category            text,
  subcategory         text,
  -- enrichment columns (filled over time; never guessed):
  base_premium_rate   numeric,
  claims_frequency    text,
  body_part_risk      text,
  safety_requirements text,
  audit_frequency     text,
  source              text default 'Workers Compensation Classification Codes (Manual DN0059)',
  updated_at          timestamptz default now()
);
