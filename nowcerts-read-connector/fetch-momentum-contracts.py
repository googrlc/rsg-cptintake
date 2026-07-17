#!/usr/bin/env python3
"""Export Momentum MCP tool schemas without exporting credentials."""

import asyncio
import json
import sys

import yaml
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def export(config_path: str, output_path: str) -> None:
    with open(config_path, "r", encoding="utf-8") as handle:
        config = yaml.safe_load(handle)
    server = config["mcp_servers"]["momentum"]
    auth = server["headers"]["Authorization"]
    async with streamablehttp_client(server["url"], headers={"Authorization": auth}) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
    tools = [tool.model_dump(mode="json") for tool in result.tools]
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump({"tools": tools}, handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: fetch-momentum-contracts.py CONFIG OUTPUT")
    asyncio.run(export(sys.argv[1], sys.argv[2]))
