# Supabase reference-table loaders

Additive, idempotent upserts into the live `rsg-infrastructure` Supabase (public schema). Match the existing table columns; `ON CONFLICT (*_code) DO NOTHING` preserves existing rows, embeddings, notion_id, and curated fields.

- `load_naics_codes.sql` — 2125 NAICS 2022 codes (from naics.com API)
- `load_sic_codes.sql` — 444 SIC codes
- `load_wc_class_codes.sql` — 423 WC (NCCI DN0059) codes
- GL already loaded (1,154) — no loader needed.

Run each in the Supabase SQL editor, or via CLI. Safe to re-run.
