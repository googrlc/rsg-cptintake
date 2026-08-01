# CRM intake desk (`crm-intake-api/`)

Leads, the intake queue and its executor, pipeline stages, agency-intake
drafting and approval, the document extractor, and the ACORD form builders.

Serves 15 routes on **:8803** — `/api/intake`, `/api/leads`,
`/api/pipeline`, `/agency-intake`, `/api/extract`.

```bash
cd crm-intake-api
pip install -e '.[dev]'
rsg-crm-intake-api            # or: uvicorn hermes_intake.service:app --port 8803
pytest                        # 101 tests
```

## This is NOT the gateway in the same repo

`nowcerts-write-gateway` and `nowcerts-read-connector` are the **AMS
submission gateway** — an MCP relay with its own operator UI, owning
`/api/intakes/*` and `/api/intake/documents`. This is the **CRM-side desk**:
who came in, what they need, where the deal sits.

They are one character apart on the wire — `/api/intakes` there,
`/api/intake` here — and the portal routes to different backends on that
trailing "s" alone (`rsg-agency-portal/server.js`). Putting them in one repo
makes the collision visible instead of merely true. **Fix the naming before
anyone tries to merge them.**

## Layout

| | |
|---|---|
| `hermes_intake/` | leads, submissions, commit, executor, priming |
| `hermes_intake/lane/` | the Command Center intake lane: extract, OCR, synthesis, validators, review, routing |
| `hermes_intake/acord/` | ACORD form builders (125/126/130/131/137/140, packs, registry) |
| `hermes_intake/agency_intake.py` + `approval.py` | draft and approve |
| `hermes_intake/worker.py` | the polling intake worker |

## The queue

Drains `object_type='intake'`. **`intake_ams` and `intake_crm` are
deliberately absent** — they have always been drained manually via
`POST /api/intake/run`, and a repo split is the wrong moment to quietly put
something on a timer.

## The shared core

```
rsg-hermes-core @ git+https://github.com/googrlc/rsg-hermes-core@5b7157dd6d7376882c8711b5d12a524eeae131fa
```

Pinned by sha. The Supabase and NowCerts clients, the opportunities pipeline,
the `portal_overrides` store, the canonical book and the approval-token gate
all come from there. Published from `rsg-hermes` via
`scripts/publish-core.sh` — the core repo is a mirror, never commit to it
directly.

## What stayed in rsg-hermes

`test_command_center.py` — it exercises the hub's dashboard, the NL agent, the
skills catalog, the team queue and the renewals classifier. The intake lane is
only part of what it covers, so it belongs where all of that is composed.
