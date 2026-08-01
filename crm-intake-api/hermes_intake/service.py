"""The CRM intake desk, as one service.

NOT the same intake as the rest of this repo. `nowcerts-write-gateway` and
`nowcerts-read-connector` are the AMS submission gateway — an MCP relay that
owns `/api/intakes/*` and `/api/intake/documents` and has its own operator UI.
This is the CRM-side desk: who came in, what they need, and where the deal sits.

The two are one character apart on the wire — `/api/intakes` there,
`/api/intake` here — and the portal routes to different backends on that
trailing "s" alone (rsg-agency-portal/server.js). They now live in one repo,
which makes the collision visible instead of merely true. Fix the naming before
anyone tries to merge them.
"""

from __future__ import annotations

import argparse
import logging
import os

from hermes_app.service import ServiceSpec, build_app

log = logging.getLogger(__name__)

SPEC = ServiceSpec(
    name="intake",
    description="Lead capture, the intake desk and queue, agency-intake drafting",
    router_modules=("hermes_intake.router",),
    path_prefixes=(
        "/api/intake", "/api/leads", "/api/pipeline", "/agency-intake", "/api/extract",
    ),
    port=8803,
    # 'intake' queue rows. intake_ams / intake_crm are drained MANUALLY via
    # POST /api/intake/run and are deliberately absent — they have always been
    # manual, and a repo split is the wrong moment to quietly put something on a
    # timer.
    queue_object_types=("intake",),
)


def create_app():
    return build_app(SPEC)


app = create_app()


def main() -> int:
    from dotenv import load_dotenv
    import uvicorn

    load_dotenv()
    logging.basicConfig(level=os.environ.get("HERMES_API_LOG_LEVEL", "INFO"))
    parser = argparse.ArgumentParser(description="RSG CRM intake desk")
    parser.add_argument("--host", default=os.environ.get("HERMES_API_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int,
                        default=int(os.environ.get("HERMES_API_PORT", SPEC.port)))
    args = parser.parse_args()
    log.info("serving %s on %s:%s", SPEC.name, args.host, args.port)
    uvicorn.run(create_app(), host=args.host, port=args.port)
    return 0
