"""Isolated bean, snapshot, sync and metadata-preservation regression coverage."""

import asyncio
import json
import multiprocessing
from unittest.mock import AsyncMock

import pytest

from gaggimate_mcp.api.websocket import GaggimateWebSocketClient
from gaggimate_mcp.beans import BeanRecorder
from gaggimate_mcp.config import GaggimateConfig
from gaggimate_mcp.errors import GaggimateError
from gaggimate_mcp.models.rating import ShotRating
from gaggimate_mcp.storage.beans import BeanStorage
from gaggimate_mcp.storage.ratings import RatingStorage


@pytest.fixture
def setup(tmp_path, monkeypatch):
    config = GaggimateConfig(storage_path=tmp_path, gaggimate_host="isolated.invalid")
    storage = BeanStorage(tmp_path)
    ratings = RatingStorage(config)
    device = GaggimateWebSocketClient(config)
    state = {"rating": 4, "notes": "Keep this tasting note", "doseIn": 18.0,
             "doseOut": 36.0, "balanceTaste": "balanced", "customMetadata": {"keep": True}}

    async def transport(kind, request_id, **kwargs):
        if kind == "req:history:notes:get":
            return {"notes": dict(state)}
        assert kind == "req:history:notes:save"
        state.clear()
        state.update(kwargs["notes"])
        return {"msg": "saved"}

    request = AsyncMock(side_effect=transport)
    monkeypatch.setattr(device, "_send_request", request)
    return storage, ratings, device, BeanRecorder(storage, device, ratings), state, request


@pytest.mark.asyncio
async def test_record_preserves_device_and_backup_metadata(setup):
    storage, ratings, _, recorder, state, request = setup
    bean = storage.save(name="Original bean", roaster="Roaster")
    original = dict(state)
    record = await recorder.record(bean["id"], "000099", "12.5")
    assert record["sync_status"] == "synced"
    assert record["shot_id"] == "99"
    assert record["synced_at"] is not None
    assert state == {**original, "beanType": "Original bean", "grindSetting": "12.5"}
    backup = ratings.get_rating("99")
    assert backup["notes"] == original["notes"]
    assert backup["rating"] == 4
    assert backup["bean_type"] == "Original bean"
    assert backup["grind_setting"] == "12.5"
    assert backup["customMetadata"] == {"keep": True}
    assert backup["ratio"] == 2
    request.reset_mock()
    assert await recorder.record(bean["id"], "99", "12.5") == record
    request.assert_not_called()


@pytest.mark.asyncio
async def test_catalog_edits_and_deletion_preserve_snapshot_and_retry(setup):
    storage, _, _, recorder, state, _ = setup
    bean = storage.save(name="Original", origin="Ethiopia", notes="Fruit")
    record = await recorder.record(bean["id"], "99", "12")
    storage.save(bean["id"], name="Renamed", origin="Elsewhere")
    assert storage.get_record("99")["bean_snapshot"] == bean
    assert storage.delete(bean["id"])
    assert storage.list_beans() == []
    assert storage.get_record("99")["bean_snapshot"] == bean
    state["beanType"] = "External change"
    retried = await recorder.sync("000099")
    assert retried["sync_status"] == "synced"
    assert retried["bean_snapshot"] == record["bean_snapshot"]
    assert state["beanType"] == "Original"


@pytest.mark.asyncio
async def test_explicit_correction_replaces_snapshot(setup):
    storage, _, _, recorder, state, _ = setup
    bean = storage.save(name="First")
    old = await recorder.record(bean["id"], "99", "12")
    other = storage.save(name="Second")
    corrected = await recorder.record(other["id"], "99", "14")
    assert corrected["bean_snapshot"] == other
    assert corrected["created_at"] == old["created_at"]
    assert state["beanType"] == "Second"
    assert state["grindSetting"] == "14"
    assert len(storage.records()) == 1


@pytest.mark.asyncio
async def test_offline_sync_is_durable_failed_not_success(setup):
    storage, ratings, _, recorder, _, request = setup
    bean = storage.save(name="Offline bean")
    request.side_effect = OSError("Device is offline")
    result = await recorder.record(bean["id"], "99", "11")
    assert result["sync_status"] == "failed"
    assert "offline" in result["sync_error"]
    assert result["synced_at"] is None
    assert BeanStorage(storage.directory).get_record("99") == result
    assert ratings.get_rating("99")["bean_type"] == "Offline bean"
    assert request.call_count == 1  # Failed prerequisite read; no blind write.


@pytest.mark.asyncio
async def test_unsupported_bean_field_does_not_claim_sync(setup):
    storage, _, _, recorder, state, request = setup
    bean = storage.save(name="Unsupported bean")

    async def unsupported(kind, request_id, **kwargs):
        if kind == "req:history:notes:get":
            return {"notes": dict(state)}
        state.clear()
        state.update({key: value for key, value in kwargs["notes"].items() if key != "beanType"})
        return {"msg": "saved"}

    request.side_effect = unsupported
    result = await recorder.record(bean["id"], "99", "13")
    assert result["sync_status"] == "failed"
    assert "beanType" in result["sync_error"]
    assert result["bean_snapshot"] == bean
    assert state["rating"] == 4
    assert state["notes"] == "Keep this tasting note"


@pytest.mark.asyncio
async def test_cancelled_sync_remains_pending_for_manual_retry(setup):
    storage, _, _, recorder, _, request = setup
    bean = storage.save(name="Pending bean")
    entered = asyncio.Event()

    async def waiting(*args, **kwargs):
        entered.set()
        await asyncio.Event().wait()

    request.side_effect = waiting
    task = asyncio.create_task(recorder.record(bean["id"], "99", "10"))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert storage.get_record("99")["sync_status"] == "pending"


@pytest.mark.asyncio
@pytest.mark.parametrize("shot_id,grind,bean_id", [
    ("../99", "12", "valid"), ("-1", "12", "valid"), ("99", " ", "valid"),
    ("99", "x" * 201, "valid"), ("99", "12", "missing"),
])
async def test_invalid_record_does_not_write_or_contact_device(setup, shot_id, grind, bean_id):
    storage, _, _, recorder, _, request = setup
    bean = storage.save(name="Test bean")
    with pytest.raises(ValueError):
        await recorder.record(bean["id"] if bean_id == "valid" else bean_id, shot_id, grind)
    assert storage.records() == []
    request.assert_not_called()


@pytest.mark.parametrize("fields", [
    {"name": " "}, {"name": "x" * 201}, {"name": "Bean", "roast_date": "2026-02-30"},
    {"name": "Bean", "roast_date": "20261025"}, {"name": "Bean", "notes": "x" * 2001},
])
def test_invalid_catalog_input_does_not_persist(setup, fields):
    storage = setup[0]
    with pytest.raises(ValueError):
        storage.save(**fields)
    assert storage.list_beans() == []


@pytest.mark.asyncio
async def test_partial_notes_update_preserves_recorder_fields(setup):
    _, ratings, device, _, state, _ = setup
    state.update(beanType="Retain bean", grindSetting="9")
    result = await device.save_shot_notes("99", notes="", rating=0)
    assert state["beanType"] == "Retain bean"
    assert state["grindSetting"] == "9"
    assert state["notes"] == ""
    assert state["rating"] == 0
    ratings.save_rating(ShotRating(shot_id="99", notes="", rating=0), result["notes"])
    saved = ratings.save_rating(ShotRating(shot_id="99", dose_in=19))
    assert saved["bean_type"] == "Retain bean"
    assert saved["grind_setting"] == "9"
    assert saved["balance_taste"] == "balanced"
    assert saved["dose_out"] == 36
    assert saved["notes"] == ""


@pytest.mark.asyncio
async def test_invalid_note_input_fails_before_device_request(setup):
    device, request = setup[2], setup[5]
    with pytest.raises(ValueError):
        await device.save_shot_notes("99", rating=7, bean_type="Valid bean")
    request.assert_not_called()


@pytest.mark.asyncio
async def test_malformed_read_refuses_blind_write(setup):
    device, request = setup[2], setup[5]
    request.return_value = {"msg": "unexpected firmware response"}
    request.side_effect = None
    with pytest.raises(GaggimateError, match="invalid shot notes"):
        await device.save_shot_notes("99", bean_type="Bean")
    assert request.call_count == 1


@pytest.mark.asyncio
async def test_concurrent_notes_updates_preserve_each_other(setup):
    _, _, device, _, state, _ = setup
    await asyncio.gather(
        device.save_shot_notes("99", bean_type="Concurrent bean"),
        device.save_shot_notes("99", grind_setting="8"),
    )
    assert state["beanType"] == "Concurrent bean"
    assert state["grindSetting"] == "8"
    assert state["rating"] == 4


def _write_process_data(directory, number):
    config = GaggimateConfig(storage_path=directory)
    RatingStorage(config).save_rating(ShotRating(shot_id=str(number), bean_type=f"Bean {number}"))
    BeanStorage(directory).save(name=f"Bean {number}")


def test_multiple_processes_do_not_lose_catalog_or_rating_writes(tmp_path):
    context = multiprocessing.get_context("spawn")
    workers = [context.Process(target=_write_process_data, args=(tmp_path, n)) for n in range(4)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=20)
        if worker.is_alive():
            worker.terminate()
            worker.join()
            pytest.fail("Persistence worker did not finish")
        assert worker.exitcode == 0
    assert len(BeanStorage(tmp_path).list_beans()) == 4
    assert len(RatingStorage(GaggimateConfig(storage_path=tmp_path)).list_ratings()) == 4


def test_corrupt_backup_is_not_silently_overwritten(tmp_path):
    storage = RatingStorage(GaggimateConfig(storage_path=tmp_path))
    storage.storage_path.write_text("{corrupted", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        storage.save_rating(ShotRating(shot_id="99", notes="New"))
    assert storage.storage_path.read_text() == "{corrupted"


@pytest.fixture
def server_tools(setup, tmp_path, monkeypatch):
    # Importing the stdio server initializes storage, so route it to isolated paths.
    for name in ("STORAGE_PATH", "PROFILES_DIR", "COFFEES_DIR", "USER_DIR"):
        monkeypatch.setenv(f"GAGGIMATE_{name}", str(tmp_path / name.lower()))
    from gaggimate_mcp import server
    storage, ratings, device, _, _, _ = setup
    monkeypatch.setattr(server, "bean_storage", storage)
    monkeypatch.setattr(server, "rating_storage", ratings)
    monkeypatch.setattr(server, "ws_client", device)
    return server


@pytest.mark.asyncio
async def test_notes_tool_passes_bean_type_and_preserves_metadata(server_tools, setup):
    result = json.loads(await server_tools.manage_shot_notes(
        shot_id="99", bean_type="Tool bean", grind_setting="7",
    ))
    assert result["success"] is True
    assert result["sync_status"]["device_synced"] is True
    assert setup[4]["beanType"] == "Tool bean"
    assert setup[4]["rating"] == 4
    assert setup[4]["notes"] == "Keep this tasting note"
    assert result["rating"]["bean_type"] == "Tool bean"
    assert result["rating"]["balance_taste"] == "balanced"


@pytest.mark.asyncio
async def test_notes_tool_rejects_invalid_metadata_before_any_write(server_tools, setup):
    result = json.loads(await server_tools.manage_shot_notes(
        shot_id="99", rating=10, notes="Must not be saved",
    ))
    assert result["success"] is False
    assert setup[1].list_ratings() == []
    setup[5].assert_not_called()


@pytest.mark.asyncio
async def test_bean_tool_returns_local_success_but_failed_sync(server_tools, setup):
    bean = json.loads(await server_tools.manage_beans(action="save", name="Tool bean"))["bean"]
    transport = setup[5].side_effect
    setup[5].side_effect = OSError("Offline")
    result = json.loads(await server_tools.manage_beans(
        action="record", bean_id=bean["id"], shot_id="99", grind_setting="8",
    ))
    assert result["success"] is True
    assert result["record"]["sync_status"] == "failed"
    assert result["record"]["sync_error"] == "Offline"
    setup[5].side_effect = transport
    retried = json.loads(await server_tools.manage_beans(action="sync", shot_id="99"))
    assert retried["success"] is True
    assert retried["record"]["sync_status"] == "synced"
    listed = json.loads(await server_tools.manage_beans(action="records", shot_id="000099"))
    assert listed["records"] == [retried["record"]]
