# The CRM intake desk. Distinct from nowcerts-write-gateway in this repo, which
# is the AMS submission gateway (Node) owning /api/intakes/*.
FROM python:3.11-slim

WORKDIR /app

# git: the shared core is a pinned git dependency, so pip needs it to fetch.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY hermes_intake ./hermes_intake
RUN pip install --no-cache-dir .

EXPOSE 8803
ENV HERMES_SERVICE=intake
CMD ["rsg-crm-intake-api", "--host", "0.0.0.0", "--port", "8803"]
