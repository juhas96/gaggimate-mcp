"""Consumer-visible journal persistence, device isolation, and local-first failures."""

from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

from gaggimate_mcp.config import GaggimateConfig
from gaggimate_mcp.desktop.app import create_app
from gaggimate_mcp.desktop.bridge import ToolOperationError
from gaggimate_mcp.desktop.workspace import workspace
from gaggimate_mcp.models.rating import ShotRating
from gaggimate_mcp.storage.beans import BeanStorage
from gaggimate_mcp.storage.ratings import RatingStorage

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "workspace-test-token-" + "x" * 32


def application(directory):
    return create_app(token=TOKEN, resource_dir=ROOT, data_dir=directory)


def client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost",
                             headers={"Authorization": "Bearer " + TOKEN})


def analysis(sid):
    return {"success": True, "incomplete": False, "rating": None, "shot": {
        "shot_id": sid, "timestamp": 1792929600, "profile_name": "Measured profile",
        "duration_seconds": 27.5, "final_weight_g": 36.2,
        "summary": {"temperature": {"avg_c": 93.1}},
        "time_series": {"points": [{"time_seconds": 1, "pressure_bar": 5.3, "temperature_c": 93.1}]},
        "phases": [{"name": "Brew", "duration_seconds": 25}],
    }}


async def catch_up(http, machine_id="default", offset=0):
    imported, errors = 0, []
    while offset is not None:
        response = await http.post(f"/api/workspace/machines/{machine_id}/sync", json={"offset": offset})
        assert response.status_code == 200
        page = response.json()
        assert 0 <= page["imported"] <= 5
        imported += page["imported"]
        errors.extend(page["errors"])
        assert page["next_offset"] is None or offset < page["next_offset"] <= offset + 50
        offset = page["next_offset"]
    return {"imported": imported, "errors": errors, "next_offset": None}


@pytest.mark.asyncio
async def test_paginated_partial_sync_catches_up_persists_and_isolates_machines(tmp_path):
    app = application(tmp_path)
    failed = {"7"}
    calls = []

    async def device(name, arguments):
        calls.append((name, arguments))
        if name == "list_recent_shots":
            ids = list(range(1, 54))[arguments["offset"]:arguments["offset"] + arguments["limit"]]
            return {"shots": [{"id": str(sid)} for sid in ids]}
        if name == "manage_shot_notes":
            assert arguments["action"] == "get"
            return {"notes": None}  # Normal device response for an unannotated shot.
        sid = arguments["shot_id"]
        if sid in failed:
            raise ToolOperationError({"success": False, "error": "Shot transfer interrupted"})
        return analysis(sid)

    app.state.runtime.bridge.call_tool = AsyncMock(side_effect=device)
    async with client(app) as http:
        response = await http.post("/api/workspace/machines/default/sync", json={})
        assert response.status_code == 200
        assert response.json() == {"imported": 5, "errors": [], "next_offset": 5}
        assert len((await http.get("/api/workspace")).json()["brews"]) == 5
        assert [args for name, args in calls if name == "list_recent_shots"] == [{"limit": 50, "offset": 0}]
        remaining = await catch_up(http, offset=response.json()["next_offset"])
        assert remaining["imported"] == 47
        assert "Shot 7" in remaining["errors"][0]
        assert any(args.get("offset") == 50 for name, args in calls if name == "list_recent_shots")
        initial = (await http.get("/api/workspace")).json()["brews"]
        assert len(initial) == 52
        assert initial[0]["analysis"]["shot"]["time_series"]
        assert initial[0]["temperature_c"] == 93.1
        assert initial[0]["notes"] == ""
        assert initial[0]["dose_out"] == 36.2
        notes = await http.post("/api/workspace/brews/device:default:1/notes", json={"notes": "Keep locally"})
        assert notes.json()["brew"]["notes"] == "Keep locally"
        failed.clear()
        assert await catch_up(http) == {"imported": 1, "errors": [], "next_offset": None}
        cached_start = len(calls)
        assert (await catch_up(http))["imported"] == 0
        assert calls[cached_start:] == [
            ("list_recent_shots", {"limit": 50, "offset": 0}),
            ("list_recent_shots", {"limit": 50, "offset": 50}),
        ]
        other = (await http.post("/api/workspace/machines", json={"name": "Second", "host": "second.local"})).json()["machine"]
        bridge = workspace(app.state.runtime).bridge(other["id"])
        assert bridge.data_dir == tmp_path / "machines" / other["id"]
        bridge.call_tool = AsyncMock(side_effect=device)
        assert (await catch_up(http, other["id"]))["imported"] == 53
        brews = (await http.get("/api/workspace")).json()["brews"]
        assert len(brews) == 106
        assert len({brew["id"] for brew in brews}) == 106
        assert next(brew for brew in brews if brew["id"] == "device:default:1")["notes"] == "Keep locally"
        assert not any(name == "manage_shot_notes" and args["action"] != "get" for name, args in calls)
    restarted = application(tmp_path)
    restarted.state.runtime.bridge.call_tool = AsyncMock(side_effect=OSError("offline"))
    async with client(restarted) as http:
        assert len((await http.get("/api/workspace")).json()["brews"]) == 106
        result = (await http.post("/api/workspace/machines/default/sync", json={})).json()
        assert result["imported"] == 0
        assert "offline" in result["errors"][0]
        assert result["next_offset"] is None
        assert len((await http.get("/api/workspace")).json()["brews"]) == 106


@pytest.mark.asyncio
async def test_legacy_snapshots_survive_catalog_changes_and_explicit_notes_sync(tmp_path):
    catalog = BeanStorage(tmp_path)
    bean = catalog.save(name="Historical coffee", origin="Ethiopia")
    record = catalog.record(bean["id"], "000009", "14")
    catalog.save(bean["id"], name="Renamed now")
    ratings = RatingStorage(GaggimateConfig(storage_path=tmp_path))
    ratings.save_rating(ShotRating(shot_id="9", notes="Old tasting note", rating=4, dose_in=18))
    original_backup = (tmp_path / "ratings.json").read_bytes()
    app = application(tmp_path)
    call = AsyncMock(return_value={"success": True, "sync_status": {"device_synced": False, "device_error": "offline"}})
    app.state.runtime.bridge.call_tool = call
    async with client(app) as http:
        brew = (await http.get("/api/workspace")).json()["brews"][0]
        assert brew["bean_snapshot"] == record["bean_snapshot"]
        assert brew["bean_name"] == "Historical coffee"
        assert brew["grind_setting"] == "14"
        assert brew["notes"] == "Old tasting note"
        assert brew["brewed_at"] == ""
        assert brew["analysis"] is None
        assert (tmp_path / "ratings.json").read_bytes() == original_backup
        local = (await http.post(f"/api/workspace/brews/{brew['id']}/notes", json={"notes": "Local first"})).json()
        call.assert_not_called()
        assert local["brew"]["notes"] == "Local first"
        result = (await http.post(f"/api/workspace/brews/{brew['id']}/notes", json={"sync_to_device": True})).json()
        assert result["sync_error"] == "offline"
        assert result["brew"]["notes"] == "Local first"
        assert result["brew"]["sync_status"] == "failed"
        call.return_value = {"success": True, "sync_status": {"device_synced": True}}
        result = (await http.post(f"/api/workspace/brews/{brew['id']}/notes", json={"sync_to_device": True})).json()
        assert result["brew"]["sync_status"] == "synced"
        assert catalog.get_record("9")["bean_snapshot"] == bean
        assert catalog.get_record("9")["sync_status"] == "synced"
        call.reset_mock()
        cleared = (await http.post(f"/api/workspace/brews/{brew['id']}/notes", json={"bean_id": None})).json()
        assert cleared["brew"]["bean_snapshot"] is None
        assert catalog.records() == []
        call.assert_not_called()


@pytest.mark.asyncio
async def test_manual_brewers_recipes_validation_and_persistence(tmp_path):
    app = application(tmp_path)
    app.state.runtime.bridge.call_tool = AsyncMock()
    async with client(app) as http:
        brewer = (await http.post("/api/workspace/brewers", json={"name": "V60", "method": "Pour over"})).json()["brewer"]
        recipe = (await http.post("/api/workspace/recipes", json={"name": "Morning", "brewer_id": brewer["id"], "dose_in": 15})).json()["recipe"]
        payload = {"brewer_id": brewer["id"], "recipe_id": recipe["id"], "brewed_at": "2026-10-25T08:00:00+02:00", "dose_in": 15, "dose_out": 250}
        brew = (await http.post("/api/workspace/brews", json=payload)).json()["brew"]
        assert brew["source"] == "manual"
        assert brew["analysis"] is None
        assert brew["machine_id"] is None
        assert brew["temperature_c"] is None
        updated = (await http.post("/api/workspace/brews", json={**payload, "id": brew["id"], "notes": "Sweet"})).json()["brew"]
        assert updated["notes"] == "Sweet"
        for fields in ({"brewed_at": "2026-10-25T08:00:00"}, {"brewed_at": 1792929600}, {"dose_in": -1}, {"rating": 5.5}, {"analysis": {"fake": True}}):
            assert (await http.post("/api/workspace/brews", json={**payload, **fields})).status_code == 422
        assert (await http.post("/api/workspace/brews", json={**payload, "brewer_id": "missing"})).status_code == 404
        assert (await http.post(f"/api/workspace/brews/{brew['id']}/notes", json={"sync_to_device": True})).status_code == 422
        other = (await http.post("/api/workspace/brewers", json={"name": "Press", "method": "Immersion"})).json()["brewer"]
        assert (await http.post("/api/workspace/brews", json={**payload, "brewer_id": other["id"]})).status_code == 422
        assert (await http.post("/api/workspace/recipes", json={**recipe, "brewer_id": other["id"]})).status_code == 409
        app.state.runtime.bridge.call_tool.assert_not_called()
    async with client(application(tmp_path)) as http:
        saved = (await http.get("/api/workspace")).json()
        assert saved["brews"][0]["notes"] == "Sweet"
        assert len(saved["brewers"]) == 2
        assert saved["recipes"] == [recipe]


@pytest.mark.asyncio
async def test_default_host_changes_never_silently_reassociate_history(tmp_path):
    app = application(tmp_path)
    async with client(app) as http:
        settings = (await http.get("/api/settings")).json()
        assert (await http.put("/api/settings", json={**settings, "host": "first.local"})).status_code == 200
        assert (await http.get("/api/workspace")).json()["machines"][0]["host"] == "first.local"
        async def device(name, arguments):
            if name == "manage_shot_notes":
                return {"notes": {}}
            return {"shots": [{"id": "1"}]} if name == "list_recent_shots" else analysis("1")
        app.state.runtime.bridge.call_tool = AsyncMock(side_effect=device)
        await http.post("/api/workspace/machines/default/sync", json={})
        assert (await http.put("/api/settings", json={**settings, "host": "other.local"})).status_code == 409
        assert app.state.runtime.bridge.host == "first.local"
        assert (await http.post("/api/workspace/machines", json={"id": "default", "name": "Same device, new address", "host": "moved.local"})).status_code == 200
        assert (await http.get("/api/settings")).json()["host"] == "moved.local"
        assert (await http.get("/api/workspace")).json()["brews"][0]["machine_id"] == "default"
        for host in ("http://bad.local", "bad/path", " spaced.local "):
            assert (await http.post("/api/workspace/machines", json={"name": "Invalid", "host": host})).status_code == 422
        app.state.runtime.settings.host = "external-change.local"
        assert (await http.post("/api/tools/list_recent_shots", json={})).status_code == 409
        assert (await http.get("/api/workspace")).status_code == 200


@pytest.mark.asyncio
async def test_note_updates_preserve_telemetry_and_only_sync_changed_fields(tmp_path):
    app = application(tmp_path)
    async def device(name, arguments):
        if name == "list_recent_shots":
            return {"shots": [{"id": "1"}]}
        if name == "analyze_shot":
            return analysis("1")
        if name == "manage_shot_notes" and arguments.get("action") == "get":
            return {"notes": {}}
        return {"sync_status": {"device_synced": True}}
    calls = AsyncMock(side_effect=device)
    app.state.runtime.bridge.call_tool = calls
    async with client(app) as http:
        await http.post("/api/workspace/machines/default/sync", json={})
        calls.reset_mock()
        response = await http.post("/api/workspace/brews/device:default:1/notes", json={"notes": "Only this", "dose_out": 40, "sync_to_device": True})
        brew = response.json()["brew"]
        assert brew["dose_out"] == 40
        assert brew["analysis"]["shot"]["final_weight_g"] == 36.2
        assert calls.call_args.args == ("manage_shot_notes", {"shot_id": "1", "action": "update", "sync_to_device": True, "notes": "Only this", "dose_out": 40})
        calls.reset_mock()
        response = await http.post("/api/workspace/brews/device:default:1/notes", json={"dose_out": None, "sync_to_device": True})
        assert response.json()["brew"]["dose_out"] is None
        assert "cannot clear dose_out" in response.json()["sync_error"]
        calls.assert_not_called()


@pytest.mark.asyncio
async def test_machine_tools_use_isolated_bridge_without_fragmenting_catalog(tmp_path):
    app = application(tmp_path)
    async with client(app) as http:
        machine = (await http.post("/api/workspace/machines", json={"name": "Other", "host": "other.local"})).json()["machine"]
        bridge = workspace(app.state.runtime).bridge(machine["id"])
        bridge.call_tool = AsyncMock(return_value={"success": True, "profiles": []})
        endpoint = f"/api/workspace/machines/{machine['id']}/tools/"
        response = await http.post(endpoint + "manage_profile", json={"action": "list"})
        assert response.json() == {"success": True, "profiles": []}
        bridge.call_tool.assert_awaited_once_with("manage_profile", {"action": "list"})
        bridge.call_tool.reset_mock()
        for name in ("manage_beans", "manage_shot_notes"):
            assert (await http.post(endpoint + name, json={"action": "list"})).status_code == 422
        bridge.call_tool.assert_not_called()


@pytest.mark.asyncio
async def test_device_metadata_partial_failure_retries_without_losing_telemetry_or_local_edits(tmp_path):
    app = application(tmp_path)
    metadata_offline = True
    analyzed = []

    async def device(name, arguments):
        if name == "list_recent_shots":
            return {"shots": [{"id": "1"}, {"id": "2"}]}
        if name == "analyze_shot":
            analyzed.append(arguments["shot_id"])
            result = analysis(arguments["shot_id"])
            if arguments["shot_id"] == "2":
                result["shot"]["summary"]["temperature"]["avg_c"] = 0
                result["shot"]["time_series"]["points"][0]["temperature_c"] = None
            return result
        assert name == "manage_shot_notes" and arguments["action"] == "get"
        if metadata_offline:
            raise OSError("metadata unavailable")
        return {"notes": {"beanType": "Device coffee", "grindSetting": "13.5", "doseIn": 18,
                          "doseOut": 40, "balanceTaste": "balanced", "rating": 4, "notes": "Device tasting note"}}

    app.state.runtime.bridge.call_tool = AsyncMock(side_effect=device)
    async with client(app) as http:
        first = (await http.post("/api/workspace/machines/default/sync", json={})).json()
        assert first["imported"] == 2
        assert len(first["errors"]) == 2
        initial = (await http.get("/api/workspace")).json()["brews"]
        assert all(brew["analysis"] is not None for brew in initial)
        assert next(brew for brew in initial if brew["shot_id"] == "2")["temperature_c"] is None
        await http.post("/api/workspace/brews/device:default:1/notes", json={"notes": "Keep my note", "dose_out": None})
        metadata_offline = False
        assert (await http.post("/api/workspace/machines/default/sync", json={})).json()["errors"] == []
        assert analyzed == ["1", "2"]
        imported = {brew["shot_id"]: brew for brew in (await http.get("/api/workspace")).json()["brews"]}
        assert imported["1"]["notes"] == "Keep my note"
        assert imported["1"]["dose_out"] is None
        assert imported["1"]["bean_name"] == "Device coffee"
        assert imported["1"]["grind_setting"] == "13.5"
        assert imported["1"]["dose_in"] == 18
        assert imported["1"]["rating"] == 4
        assert imported["2"]["dose_out"] == 40
        assert imported["2"]["notes"] == "Device tasting note"


@pytest.mark.asyncio
async def test_legacy_missing_yield_is_filled_but_explicit_clear_is_preserved(tmp_path):
    catalog = BeanStorage(tmp_path)
    bean = catalog.save(name="Legacy")
    catalog.record(bean["id"], "1", "12")
    catalog.record(bean["id"], "2", "13")
    app = application(tmp_path)

    async def device(name, arguments):
        if name == "list_recent_shots":
            return {"shots": [{"id": "1"}, {"id": "2"}]}
        if name == "manage_shot_notes":
            return {"notes": {"beanType": "Do not replace snapshot"}}
        return analysis(arguments["shot_id"])

    app.state.runtime.bridge.call_tool = AsyncMock(side_effect=device)
    async with client(app) as http:
        await http.get("/api/workspace")
        await http.post("/api/workspace/brews/device:default:2/notes", json={"dose_out": None})
        assert (await http.post("/api/workspace/machines/default/sync", json={})).json()["errors"] == []
        brews = {brew["shot_id"]: brew for brew in (await http.get("/api/workspace")).json()["brews"]}
        assert brews["1"]["dose_out"] == 36.2
        assert brews["2"]["dose_out"] is None
        assert brews["1"]["bean_name"] == "Legacy"


@pytest.mark.asyncio
async def test_manual_recipe_name_is_historical_snapshot(tmp_path):
    app = application(tmp_path)
    async with client(app) as http:
        brewer = (await http.post("/api/workspace/brewers", json={"name": "V60", "method": "Pour over"})).json()["brewer"]
        recipe = (await http.post("/api/workspace/recipes", json={"name": "Original recipe", "brewer_id": brewer["id"]})).json()["recipe"]
        payload = {"brewer_id": brewer["id"], "recipe_id": recipe["id"], "brewed_at": "2026-10-25T08:00:00Z"}
        brew = (await http.post("/api/workspace/brews", json=payload)).json()["brew"]
        assert brew["profile"] == "Original recipe"
        await http.post("/api/workspace/recipes", json={**recipe, "name": "Renamed recipe"})
        edited = (await http.post("/api/workspace/brews", json={**payload, "id": brew["id"], "notes": "Unrelated edit"})).json()["brew"]
        assert edited["profile"] == "Original recipe"
        cleared = (await http.post("/api/workspace/brews", json={**payload, "id": brew["id"], "recipe_id": None})).json()["brew"]
        assert cleared["profile"] == ""


@pytest.mark.asyncio
async def test_sync_cursor_is_validated_before_device_access_and_empty_page_finishes(tmp_path):
    app = application(tmp_path)
    calls = AsyncMock(return_value={"shots": []})
    app.state.runtime.bridge.call_tool = calls
    async with client(app) as http:
        for offset in (-1, 1.5, True, "5", None):
            response = await http.post("/api/workspace/machines/default/sync", json={"offset": offset})
            assert response.status_code == 422
        calls.assert_not_called()
        response = await http.post("/api/workspace/machines/default/sync", json={"offset": 55})
        assert response.json() == {"imported": 0, "errors": [], "next_offset": None}
        calls.assert_awaited_once_with("list_recent_shots", {"limit": 50, "offset": 55})
