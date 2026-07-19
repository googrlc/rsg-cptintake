-- General Liability class-code reference (master). 1154 codes. Idempotent.
create table if not exists public.gl_class_codes (
  code text primary key,            -- 5-digit ISO GL code, e.g. '10010'
  description text not null,
  category text, subcategory text,
  risk_level text, premium_impact text, market_size text,
  underwriting_notes text, last_review_date date,
  source text default 'ISO/RSG General Liability Class Codes (Term Store)', updated_at timestamptz default now()
);
