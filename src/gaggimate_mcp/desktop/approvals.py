"""One-use, run-scoped approvals for every agent-initiated MCP mutation."""

from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass
from typing import Any

from ag_ui.core import CustomEvent as AGUICustomEvent
from pydantic_ai import CustomEvent, RunContext
from pydantic_ai.exceptions import ToolFailed


@dataclass(kw_only=True)
class ApprovalEvent(CustomEvent, name="approval"):
    payload: dict[str, Any]

    def to_payload(self) -> AGUICustomEvent:
        return AGUICustomEvent(name="approval", value=self.payload)


@dataclass(kw_only=True)
class ApprovalResolvedEvent(CustomEvent, name="approvalResolved"):
    payload: dict[str, Any]

    def to_payload(self) -> AGUICustomEvent:
        return AGUICustomEvent(name="approvalResolved", value=self.payload)


class ApprovalGate:
    def __init__(self, timeout: float = 300):
        self.pending: dict[str, asyncio.Future[bool]] = {}
        self.timeout = timeout

    async def request(self, ctx: RunContext, tool: str, arguments: dict[str, Any]) -> None:
        identifier = secrets.token_urlsafe(24)
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        status = "cancelled"
        approved = False
        try:
            await ctx.emit(ApprovalEvent(payload={"id": identifier, "tool": tool, "arguments": arguments}))
            try:
                approved = await asyncio.wait_for(future, timeout=self.timeout)
                status = "approved" if approved else "denied"
            except TimeoutError:
                status = "expired"
            if not approved:
                raise ToolFailed(f"User approval {status}; {tool} was NOT executed. Do not ask again unless the user requests it.")
        finally:
            self.pending.pop(identifier, None)
            if not future.done():
                future.cancel()
            await ctx.emit(ApprovalResolvedEvent(payload={"id": identifier, "approved": approved, "status": status}))

    def resolve(self, identifier: str, approved: bool) -> bool:
        future = self.pending.get(identifier)
        if future is None or future.done():
            return False
        future.set_result(approved)
        return True

    def cancel_all(self) -> None:
        for future in self.pending.values():
            if not future.done():
                future.cancel()
        self.pending.clear()
