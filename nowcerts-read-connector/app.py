"""NowCerts (Momentum AMS) MCP bridge.

Thin READ-ONLY proxy: MCP JSON-RPC 2.0 over HTTP at /mcp (+ /api/mcp),
/healthz for liveness. Bearer auth via API_SERVER_KEY (mirrors the
espo-mcp / rsg-hermes-mcp bridges).

NowCerts auth: POST /api/token grant_type=password -> access_token (bearer),
auto-refreshed on 401. Only GET tools are exposed — the NowCerts AMS stays
the system of record; no writes pass through this bridge.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.parse
from typing import Any

import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("nowcerts-mcp")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

# --- config -----------------------------------------------------------------
NOWCERTS_API_URL = os.environ.get("NOWCERTS_API_URL", "https://api.nowcerts.com").rstrip("/")
NOWCERTS_USERNAME = os.environ.get("NOWCERTS_USERNAME", "").strip()
NOWCERTS_PASSWORD = os.environ.get("NOWCERTS_PASSWORD", "")
AUTH_TOKEN = os.environ.get("API_SERVER_KEY", "").strip()

MCP_PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "nowcerts-mcp-bridge"
SERVER_VERSION = "1.0.0"
HTTP_TIMEOUT = 30
MAX_TOP = 200        # cap page size to protect payload size
TRUNCATE_CHARS = 20000  # cap any single tool response length

app = FastAPI(title="NowCerts MCP Bridge", docs_url=None, redoc_url=None)


def _check_auth(request: Request) -> bool:
    if not AUTH_TOKEN:
        return True
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() == AUTH_TOKEN
    return False


# --- NowCerts API client (bearer, auto-refresh) -----------------------------
class NCError(Exception):
    pass


class NowCerts:
    """Minimal bearer-token client mirroring hermes/sync/nowcerts_client.py."""

    def __init__(self) -> None:
        if not NOWCERTS_USERNAME or not NOWCERTS_PASSWORD:
            raise NCError(
                "NOWCERTS_USERNAME and NOWCERTS_PASSWORD must be set (see /opt/app/.env)."
            )
        self._token: str | None = None

    def _auth(self) -> str:
        url = f"{NOWCERTS_API_URL}/api/token"
        resp = requests.post(
            url,
            data={"grant_type": "password", "username": NOWCERTS_USERNAME, "password": NOWCERTS_PASSWORD},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=HTTP_TIMEOUT,
        )
        if not resp.ok:
            raise NCError(f"NowCerts auth failed {resp.status_code}: {resp.text[:300]}")
        token = resp.json().get("access_token")
        if not token:
            raise NCError("NowCerts auth response missing access_token")
        self._token = token
        return token

    def _headers(self) -> dict[str, str]:
        if not self._token:
            self._auth()
        return {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}

    def get(self, path: str, params: dict[str, str] | None = None) -> Any:
        url = NOWCERTS_API_URL + path
        for attempt in range(2):
            resp = requests.get(url, headers=self._headers(), params=params, timeout=HTTP_TIMEOUT)
            if resp.status_code == 401 and attempt == 0:
                log.info("NowCerts: token expired, re-authenticating")
                self._auth()
                continue
            if not resp.ok:
                raise NCError(f"GET {path} failed {resp.status_code}: {resp.text[:300]}")
            try:
                return resp.json()
            except ValueError:
                return resp.text
        raise NCError(f"GET {path}: auth retry exhausted")


def _records(body: Any) -> Any:
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for key in ("value", "items", "results"):
            if key in body:
                return body[key]
    return body


def _text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload[:TRUNCATE_CHARS]
    return json.dumps(payload, indent=2, default=str)[:TRUNCATE_CHARS]


# --- tool catalog -----------------------------------------------------------
def _mcp_tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "ping",
            "description": "Liveness + NowCerts auth check. Fetches one policy to confirm credentials work.",
            "inputSchema": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        },
        {
            "name": "list_insureds",
            "description": "List NowCerts insured (client) records, newest changes first. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "top": {"type": "integer", "description": "Page size (1-200). Default 50."},
                    "skip": {"type": "integer", "description": "OData $skip for pagination. Default 0."},
                    "since": {"type": "string", "description": "ISO datetime; only records with changeDate >= since."},
                },
                "required": [], "additionalProperties": False,
            },
        },
        {
            "name": "list_policies",
            "description": "List NowCerts policy (bound policy) records, newest changes first. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "top": {"type": "integer", "description": "Page size (1-200). Default 50."},
                    "skip": {"type": "integer", "description": "OData $skip for pagination. Default 0."},
                    "since": {"type": "string", "description": "ISO datetime; only records with changeDate >= since."},
                },
                "required": [], "additionalProperties": False,
            },
        },
        {
            "name": "get_insured",
            "description": "Fetch a single insured by NowCerts id (InsuredDetail). Read-only.",
            "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"], "additionalProperties": False},
        },
        {
            "name": "get_policy",
            "description": "Fetch a single policy by NowCerts id (PolicyDetail). Read-only.",
            "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"], "additionalProperties": False},
        },
        {
            "name": "search_insureds",
            "description": "Search insureds by commercial or personal display name. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {"query": {"type": "string"}, "top": {"type": "integer", "description": "Max results (1-200). Default 25."}},
                "required": ["query"], "additionalProperties": False,
            },
        },
        {
            "name": "nowcerts_get",
            "description": "Thin read-only GET passthrough to the NowCerts API. path must start with /api/. Use for endpoints not covered by dedicated tools.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "API path beginning with /api/, e.g. /api/InsuredDetailList"},
                    "top": {"type": "integer"}, "skip": {"type": "integer"}, "filter": {"type": "string"},
                },
                "required": ["path"], "additionalProperties": False,
            },
        },
    ]


# --- tool handlers ----------------------------------------------------------
def _clamp_top(v: Any, default: int) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = default
    return max(1, min(n, MAX_TOP))


def _odata(top: int, skip: int, since: str | None) -> dict[str, str]:
    p = {"$count": "true", "$orderby": "changeDate desc", "$skip": str(skip), "$top": str(top)}
    if since:
        s = since if since.endswith("Z") else f"{since}Z"
        p["$filter"] = f"changeDate ge {s}"
    return p


def _run_ping(_: dict[str, Any]) -> str:
    nc = NowCerts()
    body = nc.get("/api/PolicyDetailList", params=_odata(1, 0, None))
    recs = _records(body)
    n = len(recs) if isinstance(recs, list) else "?"
    return f"nowcerts-mcp reachable. auth OK. base={NOWCERTS_API_URL}. sample policies returned={n}"


def _run_list(args: dict[str, Any], path: str) -> str:
    top = _clamp_top(args.get("top"), 50)
    try:
        skip = int(args.get("skip", 0))
    except (TypeError, ValueError):
        skip = 0
    return _text(NowCerts().get(path, params=_odata(top, skip, args.get("since"))))


def _run_single(args: dict[str, Any], path: str) -> str:
    oid = str((args.get("id") or "").strip())
    if not oid:
        return "Error: 'id' is required."
    return _text(NowCerts().get(f"{path}/{urllib.parse.quote(oid)}"))


def _run_search(args: dict[str, Any]) -> str:
    q = str((args.get("query") or "").strip())
    if not q:
        return "Error: 'query' is required."
    top = _clamp_top(args.get("top"), 25)
    # InsuredDetailList has no ``name`` field. NowCerts exposes the display
    # name as commercialName (including "Last, First" for personal insureds),
    # so the old filter returned HTTP 500 for every UI lookup. Probe each
    # query token against the documented field, union the small result sets,
    # then require every token locally so "John Smith" also matches
    # "Smith, John" without constructing a fragile multi-field OData filter.
    tokens = sorted(set(re.findall(r"[A-Za-z0-9@._&'-]+", q)), key=len, reverse=True)[:5]
    if not tokens:
        return _text({"value": []})
    candidates: dict[str, dict[str, Any]] = {}
    probe_top = min(MAX_TOP, max(50, top * 8))
    nc = NowCerts()
    folded = [token.casefold() for token in tokens]
    for token in tokens:
        safe = token.replace("'", "''")
        body = nc.get(
            "/api/InsuredDetailList",
            params={"$count": "true", "$top": str(probe_top), "$filter": f"contains(commercialName,'{safe}')"},
        )
        for record in _records(body) if isinstance(_records(body), list) else []:
            key = str(record.get("databaseId") or record.get("id") or "")
            if key:
                candidates[key] = record
        # Most searches resolve from the longest/specific token. Stop early
        # when that result set already contains an all-token match; only probe
        # the next token for generic/reordered names that need it.
        if any(
            all(part in " ".join(str(record.get(field) or "") for field in ("commercialName", "firstName", "middleName", "lastName", "dba")).casefold() for part in folded)
            for record in candidates.values()
        ):
            break

    matches = []
    for record in candidates.values():
        haystack = " ".join(
            str(record.get(field) or "")
            for field in ("commercialName", "firstName", "middleName", "lastName", "dba")
        ).casefold()
        if all(token in haystack for token in folded):
            matches.append(record)
    matches.sort(key=lambda record: str(record.get("commercialName") or "").casefold())
    return _text({"value": matches[:top], "count": len(matches)})


def _run_passthrough(args: dict[str, Any]) -> str:
    path = str((args.get("path") or "").strip())
    if not path.startswith("/api/"):
        return "Error: 'path' must begin with /api/ (read-only GET)."
    params: dict[str, str] = {}
    if args.get("top") is not None:
        params["$top"] = str(_clamp_top(args.get("top"), 50))
    if args.get("skip") is not None:
        params["$skip"] = str(int(args.get("skip")))
    if args.get("filter"):
        params["$filter"] = str(args.get("filter"))
    return _text(NowCerts().get(path, params=params or None))


_HANDLERS = {
    "ping": _run_ping,
    "list_insureds": lambda a: _run_list(a, "/api/InsuredDetailList"),
    "list_policies": lambda a: _run_list(a, "/api/PolicyDetailList"),
    "get_insured": lambda a: _run_single(a, "/api/InsuredDetail"),
    "get_policy": lambda a: _run_single(a, "/api/PolicyDetail"),
    "search_insureds": _run_search,
    "nowcerts_get": _run_passthrough,
}


# --- JSON-RPC plumbing (MCP 2024-11-05) --------------------------------------
def _result(rid: Any, result: dict[str, Any]) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rid, "result": result})


def _error(rid: Any, code: int, message: str) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "status": "ok",
        "nowcerts_base": NOWCERTS_API_URL,
        "creds_configured": bool(NOWCERTS_USERNAME and NOWCERTS_PASSWORD),
    }


@app.post("/mcp")
@app.post("/api/mcp")
async def mcp(request: Request) -> JSONResponse:
    if not _check_auth(request):
        return _error(None, -32001, "Unauthorized")
    try:
        body = await request.json()
    except Exception:
        return _error(None, -32700, "Parse error")

    method = body.get("method")
    rid = body.get("id")
    params = body.get("params") or {}

    if method == "initialize":
        return _result(rid, {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    if method in ("notifications/initialized", "initialized"):
        return JSONResponse({"jsonrpc": "2.0"})
    if method == "ping":
        return _result(rid, {})
    if method == "tools/list":
        return _result(rid, {"tools": _mcp_tools()})
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        handler = _HANDLERS.get(name)
        if handler is None:
            return _result(rid, {"content": [{"type": "text", "text": f"Unknown tool: {name}"}], "isError": True})
        try:
            text = handler(args)
        except NCError as exc:
            log.warning("tool %s NowCerts error: %s", name, exc)
            return _result(rid, {"content": [{"type": "text", "text": f"NowCerts error: {exc}"}], "isError": True})
        except Exception as exc:
            log.exception("tool %s failed", name)
            return _result(rid, {"content": [{"type": "text", "text": f"Error: {exc}"}], "isError": True})
        return _result(rid, {"content": [{"type": "text", "text": text}]})

    return _error(rid, -32601, f"Method not found: {method}")
