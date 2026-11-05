"""Raw firmware import preserves fields while creating only an unselected copy."""

import copy
import importlib
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from gaggimate_mcp.api.websocket import GaggimateWebSocketClient
from gaggimate_mcp.config import GaggimateConfig
from gaggimate_mcp.models.profile_import import imported_profile
from gaggimate_mcp.storage.profiles import ProfileStorage


def raw_profile():
    return {
        "id": "existing-device-id", "selected": True, "favorite": True,
        "label": "Device recipe", "type": "pro", "temperature": 93,
        "description": "Preserve this full recipe", "dose": 18.5,
        "extension": {"future": [1, "retain", None]},
        "phases": [
            {"name": "Stabilize", "phase": "preinfusion", "duration": 3, "valve": 0,
             "temperature": 0, "pump": 0,
             "transition": {"type": "instant", "duration": 0, "target": "time", "adaptive": False}},
            {"name": "Main Extraction", "phase": "brew", "duration": 30, "valve": 1,
             "temperature": 93, "pump": {"target": "flow", "pressure": -1, "flow": -1, "extension": "keep"},
             "transition": {"type": "ease-in-out", "duration": 3, "target": "time", "adaptive": True},
             "targets": [{"type": "volumetric", "operator": "gte", "value": 36, "extension": True}],
             "extension": {"phase": "keep"}},
        ],
    }


@pytest.fixture
def server(tmp_path, monkeypatch):
    for field in ("STORAGE_PATH", "PROFILES_DIR", "COFFEES_DIR", "USER_DIR"):
        monkeypatch.setenv("GAGGIMATE_" + field, str(tmp_path / field.lower()))
    module = importlib.import_module("gaggimate_mcp.server")
    config = GaggimateConfig(storage_path=tmp_path, ai_profile_suffix=" [Imported AI]")
    monkeypatch.setattr(module, "config", config)
    monkeypatch.setattr(module, "ws_client", GaggimateWebSocketClient(config))
    monkeypatch.setattr(module, "profile_storage", ProfileStorage(config))
    return module


@pytest.mark.asyncio
async def test_import_preserves_full_payload_creates_new_copy_and_saves_version(server, monkeypatch):
    payload = raw_profile()
    original = copy.deepcopy(payload)
    expected = {**payload, "id": "new", "selected": False, "label": "Device recipe [Imported AI]"}

    async def transport(kind, request_id, **kwargs):
        assert kind == "req:profiles:save"
        assert kwargs == {"profile": expected}
        return {"profile": {**kwargs["profile"], "id": "new-device-id"}}

    transport_mock = AsyncMock(side_effect=transport)
    monkeypatch.setattr(server.ws_client, "_send_request", transport_mock)
    result = json.loads(await server.manage_profile(action="import", profile_data=payload, profile_id="must-not-overwrite"))
    assert result["success"] is True
    assert result["profile"] == {**expected, "id": "new-device-id"}
    transport_mock.assert_awaited_once()
    saved = json.loads(Path(result["version_info"]["file_path"]).read_text())
    assert saved["profile"] == result["profile"]
    assert saved["metadata"]["action"] == "import"
    assert payload == original
    assert imported_profile(expected, " [Imported AI]")["label"] == expected["label"]


@pytest.mark.parametrize("pump", [0, 100, {"target": "pressure", "pressure": -1, "flow": -1},
                                 {"target": "power", "pressure": 100, "flow": 0},
                                 {"target": "off", "pressure": 0, "flow": 0}])
def test_import_accepts_observed_and_documented_firmware_pump_forms(pump):
    payload = raw_profile()
    payload["phases"][1]["pump"] = pump
    assert imported_profile(payload, " [AI]")["phases"][1]["pump"] == pump


@pytest.mark.asyncio
@pytest.mark.parametrize("path,value", [
    (("temperature",), float("nan")), (("temperature",), float("inf")),
    (("temperature",), 59), (("temperature",), True), (("type",), "standard"),
    (("label",), " "), (("description",), 3), (("phases",), []),
    (("phases", 0, "duration"), 0), (("phases", 0, "duration"), 121),
    (("phases", 0, "valve"), True), (("phases", 0, "valve"), 0.5),
    (("phases", 0, "temperature"), 30), (("phases", 0, "pump"), -1),
    (("phases", 1, "pump", "pressure"), 13), (("phases", 1, "pump", "flow"), -2),
    (("phases", 1, "transition", "duration"), -1),
    (("phases", 1, "transition", "adaptive"), "yes"),
    (("phases", 1, "targets", 0, "value"), float("inf")),
    (("extension", "future"), {"nonfinite": float("nan")}),
])
async def test_invalid_import_never_writes_device_or_version(server, monkeypatch, path, value):
    payload = raw_profile()
    target = payload
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value
    request = AsyncMock()
    monkeypatch.setattr(server.ws_client, "_send_request", request)
    result = json.loads(await server.manage_profile(action="import", profile_data=payload))
    assert result["success"] is False
    assert "Invalid profile import" in result["error"]
    request.assert_not_called()
    assert server.profile_storage.list_profile_versions() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", [None, "{", [], {"temperature": float("inf")}])
async def test_invalid_object_import_is_rejected_before_device_write(server, monkeypatch, raw):
    request = AsyncMock()
    monkeypatch.setattr(server.ws_client, "_send_request", request)
    result = json.loads(await server.manage_profile(action="import", profile_data=raw))
    assert result["success"] is False
    request.assert_not_called()


@pytest.mark.asyncio
async def test_import_object_through_real_stdio_mcp_and_websocket(tmp_path, monkeypatch):
    """Exercise MCP argument coercion and serialization, not a direct Python call."""
    from websockets import serve
    from gaggimate_mcp.desktop.bridge import MCPBridge

    monkeypatch.setenv("GAGGIMATE_GAGGIMATE_PROTOCOL", "ws")
    monkeypatch.setenv("GAGGIMATE_AI_PROFILE_SUFFIX", " [AI]")
    requests = []

    async def device(socket, path=None):
        request = json.loads(await socket.recv())
        requests.append(request)
        if request["tp"] == "req:profiles:save":
            response = {"profile": {**request["profile"], "id": "imported-over-real-mcp"}}
        else:
            response = {"error": "Import must not load, overwrite, select, or delete a profile"}
        await socket.send(json.dumps({"tp": request["tp"].replace("req:", "res:"),
                                      "rid": request["rid"], **response}))

    payload = raw_profile()
    original = copy.deepcopy(payload)
    async with serve(device, "127.0.0.1", 0) as simulator:
        port = simulator.sockets[0].getsockname()[1]
        bridge = MCPBridge(Path(__file__).resolve().parents[1], tmp_path, f"127.0.0.1:{port}")
        result = await bridge.call_tool("manage_profile", {"action": "import", "profile_data": payload})
    expected = {**payload, "id": "new", "selected": False, "label": "Device recipe [AI]"}
    assert len(requests) == 1
    assert requests[0]["tp"] == "req:profiles:save"
    assert requests[0]["profile"] == expected
    assert result["success"] is True
    assert result["profile"] == {**expected, "id": "imported-over-real-mcp"}
    assert json.loads(Path(result["version_info"]["file_path"]).read_text())["profile"] == result["profile"]
    assert payload == original
