#!/usr/bin/env bash
# Idempotent dependency bootstrap for the rsg-cptintake Cloud Agent environment.
# Runs after the repository is checked out. Safe to run repeatedly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[install] nowcerts-write-gateway (primary product): npm dependencies + UI build"
cd "$REPO_ROOT/nowcerts-write-gateway"
npm install
npm run build:ui

# The gateway spawns scripts/render-intake-report.py (via PYTHON_BIN, default
# python3) to render the PDF risk report. It imports reportlab. Installing into
# the user site keeps the default python3 usable by `npm test` and the
# /api/intakes/:id/report.pdf route without extra environment variables.
echo "[install] reportlab for the PDF risk-report renderer"
python3 -m pip install --user --break-system-packages reportlab==5.0.0

echo "[install] nowcerts-read-connector: FastAPI/uvicorn/requests"
python3 -m pip install --user --break-system-packages \
  -r "$REPO_ROOT/nowcerts-read-connector/requirements.txt"

# crm-intake-api is intentionally NOT installed here: it depends on the private
# package rsg-hermes-core (git+https://github.com/googrlc/rsg-hermes-core@<sha>),
# which the default Cursor GitHub token cannot access. To enable it, grant the
# Cursor GitHub app access to googrlc/rsg-hermes-core, then run in crm-intake-api/:
#   python3 -m venv .venv && ./.venv/bin/pip install -e '.[dev]'

echo "[install] done"
