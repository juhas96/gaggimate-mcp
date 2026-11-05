"""The desktop has no duplicate device implementation: all operations use MCP stdio."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from fastmcp.client.transports import StdioTransport
from fastmcp.exceptions import ToolError
from pydantic_ai.mcp import MCPToolset


class ToolOperationError(Exception):
    def __init__(self, result: dict[str, Any], status_code: int = 502):
        self.result = result
        self.status_code = status_code
        super().__init__(str(result.get("error", "MCP operation failed")))


def decode_result(result: Any) -> Any:
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            return result
    if isinstance(result, dict) and result.get("success") is False:
        raise ToolOperationError(result)
    return result


# Missing/new tool actions are mutations until explicitly reviewed. Defaults match
# the real MCP tools, rather than trusting model-provided read-only annotations.
READ_ONLY_ACTIONS = {
    "manage_profile": (None, {"list", "get"}),
    "manage_shot_notes": ("update", {"get"}),
    "manage_coffee": (None, {"list", "read"}),
    "manage_user_setup": ("read", {"read"}),
    "manage_grind_map": ("read", {"read"}),
    "manage_brewing_insights": ("read", {"read"}),
    "manage_beans": (None, {"list", "records"}),
    "read_knowledge": (None, {"list", "read"}),
}
READ_ONLY_TOOLS = frozenset({"analyze_shot", "list_recent_shots", "diagnose_connection"})


def requires_approval(name: str, arguments: dict[str, Any]) -> bool:
    if name in READ_ONLY_TOOLS:
        return False
    if name in READ_ONLY_ACTIONS:
        default, actions = READ_ONLY_ACTIONS[name]
        return arguments.get("action", default) not in actions
    return True


class MCPBridge:
    def __init__(self, resource_dir: Path, data_dir: Path, host: str):
        self.resource_dir = resource_dir
        self.data_dir = data_dir
        self.host = host
        self.device_lock = asyncio.Lock()

    def environment(self) -> dict[str, str]:
        # Do not pass desktop bearer credentials or unrelated AI provider keys to MCP.
        env = {
            key: value for key, value in os.environ.items()
            if key in {"PATH", "HOME", "USER", "LANG", "SYSTEMROOT", "TEMP", "TMP"}
            or (key.startswith("GAGGIMATE_") and not key.startswith("GAGGIMATE_DESKTOP_"))
        }
        env["PYTHONPATH"] = str(self.resource_dir / "src")
        env["GAGGIMATE_GAGGIMATE_HOST"] = self.host
        env["GAGGIMATE_STORAGE_PATH"] = str(self.data_dir)
        env["GAGGIMATE_KNOWLEDGE_DIR"] = str(self.resource_dir / "knowledge")
        writable_root = self.resource_dir if self.data_dir == self.resource_dir / "data" else self.data_dir
        for field, directory in (("PROFILES_DIR", "profiles"), ("COFFEES_DIR", "coffees"), ("USER_DIR", "user")):
            env[f"GAGGIMATE_{field}"] = str(writable_root / directory)
        return env

    def toolset(self, process_tool_call=None) -> MCPToolset:
        transport = StdioTransport(
            command=sys.executable,
            args=["-c", "from gaggimate_mcp.server import mcp; mcp.run(transport='stdio')"],
            cwd=str(self.resource_dir),
            env=self.environment(),
            keep_alive=False,
        )
        return MCPToolset(
            transport,
            process_tool_call=process_tool_call,
            tool_error_behavior="error",
            init_timeout=30,
            read_timeout=90,
        )

    async def list_tools(self) -> list[dict[str, Any]]:
        async with self.device_lock:
            async with self.toolset() as toolset:
                tools = await toolset.list_tools()
                return [
                    {"name": tool.name, "description": tool.description or "", "inputSchema": tool.model_dump(by_alias=True)["inputSchema"]}
                    for tool in tools
                ]

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        async with self.device_lock:
            async with self.toolset() as toolset:
                tools = await toolset.list_tools()
                if name not in {tool.name for tool in tools}:
                    raise ToolOperationError({"success": False, "error": f"Unknown MCP tool: {name}"}, 404)
                try:
                    return decode_result(await toolset.direct_call_tool(name, arguments))
                except ToolError as exc:
                    raise ToolOperationError({"success": False, "error": str(exc)}, 422) from exc
