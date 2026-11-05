"""Offline desktop boundaries, real AG-UI serialization, and safe MCP discovery."""

import asyncio
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from ag_ui.core import CustomEvent, RunAgentInput
from pydantic_ai import Agent, CancellationToken, ModelRetry, RunContext
from pydantic_ai.exceptions import ToolFailed
from pydantic_ai.models.test import TestModel
from pydantic_ai.providers.openai_chatgpt import OpenAIChatGPTCredentials
from pydantic_ai.ui.ag_ui import AGUIAdapter

from gaggimate_mcp.desktop.agent import render_ui, unknown_function_response
from gaggimate_mcp.desktop.app import AgentStreamResponse, DesktopSettings, create_app, safe_stream_error
from gaggimate_mcp.desktop.approvals import ApprovalGate
from gaggimate_mcp.desktop.auth import ChatGPTAuth, InstallationLock, PrivateCredentialSource
from gaggimate_mcp.desktop.bridge import MCPBridge, ToolOperationError, requires_approval

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "desktop-test-token-" + "x" * 32
ENVELOPE = {
    "version": "v1.0",
    "createSurface": {
        "surfaceId": "analysis", "catalogId": "urn:gaggimate:catalog:1.0",
        "components": [{"id": "root", "component": "Text", "text": "Observed data"}],
    },
}


def credentials(refresh="test-refresh"):
    return OpenAIChatGPTCredentials(
        client_id="app-client", access_token="test-access", refresh_token=refresh,
        id_token="test-id", scope="openid chatgpt.tokens.use.direct",
    )


def run_payload():
    return {
        "threadId": "test-thread", "runId": "test-run", "state": {},
        "messages": [{"id": "user-1", "role": "user", "content": "Show shot analysis"}],
        "tools": [], "context": [], "forwardedProps": {},
    }


@pytest.mark.asyncio
async def test_credentials_atomic_private_refresh_and_logout(tmp_path, monkeypatch):
    source = PrivateCredentialSource(tmp_path / ".desktop" / "chatgpt-credentials.json")
    await source.save(credentials())
    assert stat.S_IMODE(source.path.stat().st_mode) == 0o600
    assert (await source.load()).refresh_token == "test-refresh"
    original = source.path.read_bytes()
    replace = os.replace

    def fail_replace(*args):
        raise OSError("disk unavailable")

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(OSError):
        await source.save(credentials("replacement"))
    assert source.path.read_bytes() == original
    assert list(source.path.parent.iterdir()) == [source.path]
    monkeypatch.setattr(os, "replace", replace)
    await source.save(credentials("replacement"))
    assert (await source.load()).refresh_token == "replacement"
    source.clear()
    with pytest.raises(PermissionError):
        await source.save(credentials("late-refresh-after-logout"))
    assert not source.path.exists()


@pytest.mark.asyncio
async def test_credentials_reject_symlink_and_public_permissions(tmp_path):
    external = tmp_path / "codex-auth.json"
    external.write_text(json.dumps({"secret": "external-app"}))
    private = tmp_path / "chatgpt-credentials.json"
    private.symlink_to(external)
    source = PrivateCredentialSource(private)
    with pytest.raises(OSError):
        await source.load()
    source.clear()
    assert json.loads(external.read_text()) == {"secret": "external-app"}
    if os.name == "posix":
        source = PrivateCredentialSource(private)
        await source.save(credentials())
        private.chmod(0o644)
        with pytest.raises(PermissionError):
            await source.load()


@pytest.mark.asyncio
async def test_denied_plan_never_installs_provider(tmp_path):
    auth = ChatGPTAuth(tmp_path)
    denied = credentials()
    denied.scope = "openid"
    await auth.source.save(denied)
    await auth.initialize()
    assert auth.status == "error"
    assert not auth.authenticated
    assert auth.provider is None
    assert "plan usage" in auth.error
    await auth.logout()
    assert not auth.source.path.exists()


def test_installation_lock_excludes_second_refresh_owner(tmp_path):
    first = InstallationLock(tmp_path)
    second = InstallationLock(tmp_path)
    first.acquire()
    try:
        with pytest.raises(RuntimeError, match="Another Gaggimate"):
            second.acquire()
    finally:
        first.release()
    second.acquire()
    second.release()


@pytest.mark.parametrize("host", ["http://gaggimate.local", "host/path", "user@host", "host:0", "host:70000", "host\n", "bad..local"])
def test_invalid_hosts_are_rejected(host):
    with pytest.raises(ValueError):
        DesktopSettings(host=host)


@pytest.mark.parametrize("host", ["gaggimate.local", "192.168.1.23", "localhost:8080", "[::1]:8080"])
def test_valid_hosts_are_preserved(host):
    assert DesktopSettings(host=host).host == host


def test_bridge_environment_uses_actual_prefix_and_shared_storage(tmp_path, monkeypatch):
    monkeypatch.setenv("GAGGIMATE_DESKTOP_TOKEN", "must-not-reach-mcp")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-mcp")
    bridge = MCPBridge(ROOT, ROOT / "data", "192.168.1.12")
    env = bridge.environment()
    assert env["GAGGIMATE_GAGGIMATE_HOST"] == "192.168.1.12"
    assert env["GAGGIMATE_STORAGE_PATH"] == str(ROOT / "data")
    assert env["GAGGIMATE_COFFEES_DIR"] == str(ROOT / "coffees")
    assert "GAGGIMATE_DESKTOP_TOKEN" not in env
    assert "OPENAI_API_KEY" not in env
    packaged = MCPBridge(ROOT, tmp_path, "gaggimate.local").environment()
    assert packaged["GAGGIMATE_USER_DIR"] == str(tmp_path / "user")
    assert packaged["GAGGIMATE_KNOWLEDGE_DIR"] == str(ROOT / "knowledge")


def test_mutation_classification_is_default_deny():
    assert not requires_approval("manage_profile", {"action": "list"})
    assert not requires_approval("manage_beans", {"action": "records"})
    assert not requires_approval("manage_user_setup", {})
    assert requires_approval("manage_shot_notes", {})
    assert requires_approval("manage_profile", {"action": "delete", "confirm_delete": True})
    assert requires_approval("manage_beans", {"action": "record"})
    assert requires_approval("new_future_tool", {"action": "read"})


@pytest.mark.asyncio
async def test_approval_is_single_use_and_timeout_cleans_pending():
    gate = ApprovalGate(timeout=1)
    emitted = asyncio.Queue()

    async def emit(event):
        await emitted.put(event.to_payload())

    context = SimpleNamespace(emit=emit)
    task = asyncio.create_task(gate.request(context, "manage_profile", {"action": "create"}))
    event = await emitted.get()
    assert event.name == "approval"
    identifier = event.value["id"]
    assert gate.resolve(identifier, True)
    assert not gate.resolve(identifier, True)
    await task
    assert not gate.pending
    assert (await emitted.get()).value["status"] == "approved"

    gate.timeout = 0.001
    with pytest.raises(ToolFailed, match="expired"):
        await gate.request(context, "manage_profile", {"action": "delete"})
    assert not gate.pending


@pytest.mark.asyncio
async def test_cancelled_approval_never_executes_and_clears_pending():
    gate = ApprovalGate()
    emitted = asyncio.Queue()

    async def emit(event):
        await emitted.put(event.to_payload())

    task = asyncio.create_task(gate.request(SimpleNamespace(emit=emit), "manage_beans", {"action": "delete"}))
    event = await emitted.get()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not gate.pending
    assert not gate.resolve(event.value["id"], True)


@pytest.mark.asyncio
async def test_agui_emits_live_approval_before_tool_finishes():
    gate = ApprovalGate()

    async def mutation(ctx: RunContext):
        await gate.request(ctx, "manage_profile", {"action": "select", "profile_id": "test"})
        return {"success": True}

    agent = Agent(TestModel(call_tools=["mutation"], custom_output_text="Approved"))
    agent.tool(mutation)
    adapter = AGUIAdapter(agent=agent, run_input=RunAgentInput.model_validate(run_payload()))
    saw_approval = False
    async with asyncio.timeout(5):
        async for event in adapter.run_stream():
            if isinstance(event, CustomEvent) and event.name == "approval":
                saw_approval = True
                assert gate.resolve(event.value["id"], True)
    assert saw_approval
    assert not gate.pending


@pytest.mark.asyncio
async def test_render_ui_metadata_is_real_agui_custom_event():
    def visual():
        return render_ui(ENVELOPE)

    agent = Agent(TestModel(call_tools=["visual"], custom_output_text="Shown"), tools=[visual])
    adapter = AGUIAdapter(agent=agent, run_input=RunAgentInput.model_validate(run_payload()))
    events = [event async for event in adapter.run_stream()]
    custom = [event for event in events if isinstance(event, CustomEvent)]
    assert len(custom) == 1
    assert custom[0].name == "a2ui"
    assert custom[0].value == ENVELOPE
    assert events[0].type == "RUN_STARTED"
    assert events[-1].type == "RUN_FINISHED"


def test_render_ui_rejects_old_protocol_and_unknown_catalog():
    with pytest.raises(ModelRetry):
        render_ui({"version": "v0.9", "createSurface": {}})
    with pytest.raises(ModelRetry):
        render_ui({"version": "v1.0", "createSurface": {"surfaceId": "x", "catalogId": "remote"}})
    result = unknown_function_response({"version": "v1.0", "callAgentFunction": {"functionCallId": "f-1"}})
    assert result["agentFunctionResponse"]["functionCallId"] == "f-1"
    assert result["agentFunctionResponse"]["error"]["code"] == "UNKNOWN_FUNCTION"


@pytest.mark.asyncio
async def test_api_auth_settings_device_errors_and_agent_signin_boundary(tmp_path, monkeypatch):
    app = create_app(token=TOKEN, resource_dir=ROOT, data_dir=tmp_path)
    async with app.router.lifespan_context(app):
        runtime = app.state.runtime
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            assert (await client.get("/api/status")).status_code == 401
            client.headers["Authorization"] = "Bearer " + TOKEN
            response = await client.get("/api/status")
            assert response.json()["ready"] is True
            assert response.json()["authenticated"] is False
            assert "test-access" not in response.text
            denied = await client.get("/api/status", headers={"Origin": "https://untrusted.example"})
            assert denied.status_code == 403
            allowed = await client.get("/api/status", headers={"Origin": "tauri://localhost"})
            assert allowed.headers["access-control-allow-origin"] == "tauri://localhost"
            assert (await client.post("/api/agent", json=run_payload())).status_code == 401
            assert (await client.put("/api/settings", json={"host": "http://bad", "model": "gpt-5.4"})).status_code == 422
            changed = await client.put("/api/settings", json={"host": "localhost:8081", "model": "gpt-5.4"})
            assert changed.status_code == 200
            assert runtime.bridge.environment()["GAGGIMATE_GAGGIMATE_HOST"] == "localhost:8081"
            assert json.loads(runtime.settings_path.read_text())["host"] == "localhost:8081"
            assert (await client.post("/api/tools/list_recent_shots", content="{", headers={"Content-Type": "application/json"})).status_code == 400
            error = {"success": False, "error": "Device unreachable", "suggestion": "Check its address"}
            monkeypatch.setattr(runtime.bridge, "call_tool", AsyncMock(side_effect=ToolOperationError(error)))
            failed = await client.post("/api/tools/list_recent_shots", json={})
            assert failed.status_code == 502
            assert failed.json() == error
            assert (await client.post("/api/approvals/missing", json={"approve": True})).status_code == 404
            assert (await client.post("/api/approvals/missing", json={"approve": "true"})).status_code == 422


@pytest.mark.asyncio
async def test_api_sse_contract_and_client_tool_rejection(tmp_path, monkeypatch):
    app = create_app(token=TOKEN, resource_dir=ROOT, data_dir=tmp_path)
    async with app.router.lifespan_context(app):
        runtime = app.state.runtime
        runtime.auth.status = "signed_in"
        runtime.auth.provider = SimpleNamespace(client=SimpleNamespace(close=AsyncMock()))
        agent = Agent(TestModel(call_tools=[], custom_output_text="Actual AG-UI stream"))
        monkeypatch.setattr("gaggimate_mcp.desktop.app.build_agent", lambda *args: agent)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1", headers={"Authorization": "Bearer " + TOKEN}) as client:
            payload = run_payload()
            payload["tools"] = [{"name": "shell", "description": "not permitted", "parameters": {"type": "object"}}]
            assert (await client.post("/api/agent", json=payload)).status_code == 422
            response = await client.post("/api/agent", json=run_payload())
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            events = [json.loads(line[5:].strip()) for line in response.text.splitlines() if line.startswith("data:")]
            assert events[0]["type"] == "RUN_STARTED"
            assert events[-1]["type"] == "RUN_FINISHED"
            assert any(event["type"] == "TEXT_MESSAGE_CONTENT" for event in events)
            assert runtime.active_token is None


def test_provider_errors_do_not_leak_credentials():
    secret = "VERY_PRIVATE_REFRESH_TOKEN"
    assert secret not in safe_stream_error("Refresh failed with token " + secret)
    assert "settings/usage" in safe_stream_error("subscription_sharing_usage_limit_exceeded")
    assert "No API billing fallback" in safe_stream_error("unexpected " + secret)


@pytest.mark.asyncio
async def test_real_stdio_tool_discovery_and_knowledge_without_oauth(tmp_path):
    bridge = MCPBridge(ROOT, tmp_path, "gaggimate.local")
    tools = await bridge.list_tools()
    names = {tool["name"] for tool in tools}
    assert {"read_knowledge", "manage_profile", "manage_shot_notes", "manage_beans"} <= names
    assert all(isinstance(tool["inputSchema"], dict) for tool in tools)
    result = await bridge.call_tool("read_knowledge", {"action": "list"})
    assert result["success"] is True
    with pytest.raises(ToolOperationError) as error:
        await bridge.call_tool("does_not_exist", {})
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_disconnect_cancels_silent_stream_and_closes_iterators(tmp_path):
    app = create_app(token=TOKEN, resource_dir=ROOT, data_dir=tmp_path)
    runtime = app.state.runtime
    token = CancellationToken()
    runtime.active_token = token
    closed = asyncio.Event()
    first_chunk = asyncio.Event()

    async def events():
        try:
            yield CustomEvent(name="waiting", value={})
            await asyncio.Event().wait()
        finally:
            closed.set()

    async def receive():
        await first_chunk.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            first_chunk.set()

    adapter = AGUIAdapter(
        agent=Agent(TestModel(call_tools=[])),
        run_input=RunAgentInput.model_validate(run_payload()),
    )
    response = AgentStreamResponse(adapter, events(), runtime, token)
    async with asyncio.timeout(5):
        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
    assert closed.is_set()
    assert token.cancelled
    assert runtime.active_token is None


@pytest.mark.asyncio
async def test_login_callback_is_async_and_logout_cancels_it(tmp_path, monkeypatch):
    callback_started = asyncio.Event()
    callback_cancelled = asyncio.Event()

    class Flow:
        def authorization_url(self, **kwargs):
            return "https://auth.openai.com/private-url-not-for-the-webview"

        async def exchange_code_from_callback(self):
            callback_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                callback_cancelled.set()

    monkeypatch.setattr("gaggimate_mcp.desktop.auth.OpenAIChatGPTOAuthFlow", lambda **kwargs: Flow())
    monkeypatch.setattr("gaggimate_mcp.desktop.auth.webbrowser.open", lambda url: True)
    auth = ChatGPTAuth(tmp_path)
    auth.start_login()
    assert auth.status == "pending"
    await asyncio.wait_for(callback_started.wait(), timeout=2)
    await auth.logout()
    assert callback_cancelled.is_set()
    assert auth.status == "signed_out"
    assert not auth.source.path.exists()


@pytest.mark.asyncio
async def test_oauth_callback_error_is_visible_but_redacted(tmp_path, monkeypatch):
    class Flow:
        def __init__(self, **kwargs):
            pass

        def authorization_url(self, **kwargs):
            return "https://auth.openai.com/private-url"

        async def exchange_code_from_callback(self):
            raise ValueError("PRIVATE_ACCESS_TOKEN in provider body")

    monkeypatch.setattr("gaggimate_mcp.desktop.auth.OpenAIChatGPTOAuthFlow", Flow)
    monkeypatch.setattr("gaggimate_mcp.desktop.auth.webbrowser.open", lambda url: True)
    auth = ChatGPTAuth(tmp_path)
    auth.start_login()
    await auth.login_task
    assert auth.status == "error"
    assert auth.error
    assert "PRIVATE_ACCESS_TOKEN" not in auth.error
    assert not auth.source.path.exists()
