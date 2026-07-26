FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY scripts/build-ui.js ./scripts/build-ui.js
COPY web ./web
RUN npm run build:ui && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    GATEWAY_MODE=shadow \
    GATEWAY_DATA_DIR=/data \
    PYTHON_BIN=/opt/report-venv/bin/python3

# tesseract-ocr + the English language pack power OCR of scanned documents.
# Barcode decoding needs no system package — the WASM decoder ships in
# node_modules and is loaded from disk, never fetched.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates poppler-utils python3 python3-venv \
       tesseract-ocr tesseract-ocr-eng \
    && python3 -m venv /opt/report-venv \
    && /opt/report-venv/bin/pip install --no-cache-dir reportlab==4.4.3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY src ./src
COPY scripts/render-intake-report.py ./scripts/render-intake-report.py
COPY web/assets ./web/assets

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
