"""Native library roundtrip, rollback, migration and immutable-history invariants."""

import json
import sqlite3
from types import SimpleNamespace

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from gaggimate_mcp.desktop.library_api import routes
from gaggimate_mcp.storage.beans import BeanStorage


def workspace_brew(directory, brew):
    with sqlite3.connect(directory / "workspace.sqlite3") as db:
        db.execute("CREATE TABLE IF NOT EXISTS brews (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.execute("INSERT INTO brews VALUES (?, ?)", (brew["id"], json.dumps(brew)))


def read_brew(directory, identifier="brew"):
    with sqlite3.connect(directory / "workspace.sqlite3") as db:
        return json.loads(db.execute("SELECT data FROM brews WHERE id = ?", (identifier,)).fetchone()[0])


def test_existing_database_and_legacy_save_still_work(tmp_path):
    old = {"id": "old", "name": "Legacy", "roaster": "Roaster", "origin": "",
           "roast_date": "", "notes": "Original", "created_at": "2025-01-01T00:00:00+00:00"}
    with sqlite3.connect(tmp_path / "beans.sqlite3") as db:
        db.execute("CREATE TABLE beans (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.execute("INSERT INTO beans VALUES (?, ?)", (old["id"], json.dumps(old)))
    storage = BeanStorage(tmp_path)
    assert storage.list_beans() == [old]
    updated = storage.save("old", name=None, roaster=None, roast_date=None, process="Washed", rating=4.5)
    assert updated["name"] == "Legacy"
    assert updated["notes"] == "Original"
    assert updated["created_at"] == old["created_at"]
    assert updated["process"] == "Washed"
    assert storage.list_grinders() == []


@pytest.mark.parametrize("kind", ["beans", "grinders"])
def test_merge_moves_references_without_changing_history(tmp_path, kind):
    storage = BeanStorage(tmp_path)
    save = storage.save if kind == "beans" else storage.save_grinder
    source = save(name="Original", notes="Before")
    target = save(name="Destination", notes="Keep destination")
    field = "bean" if kind == "beans" else "grinder"
    brew = {"id": "brew", f"{field}_id": source["id"], f"{field}_name": source["name"],
            f"{field}_snapshot": source, "notes": "Keep brew notes", "grind_setting": "12"}
    workspace_brew(tmp_path, brew)
    legacy = storage.record(source["id"], "123", "12") if kind == "beans" else None
    result = storage.merge(kind, source["id"], target["id"])
    assert result["updated"]["brews"] == 1
    assert read_brew(tmp_path) == {**brew, f"{field}_id": target["id"]}
    assert storage.export_catalog()[kind] == [target]
    if legacy:
        assert storage.get_record("123") == {**legacy, "bean_id": target["id"]}
    storage.delete_catalog(kind, target["id"])
    assert read_brew(tmp_path)[f"{field}_snapshot"] == source
    assert read_brew(tmp_path)[f"{field}_id"] == target["id"]


def test_merge_failure_rolls_back_both_databases(tmp_path):
    storage = BeanStorage(tmp_path)
    source, target = storage.save(name="Source"), storage.save(name="Target")
    legacy = storage.record(source["id"], "123", "11")
    brew = {"id": "brew", "bean_id": source["id"], "bean_snapshot": source}
    workspace_brew(tmp_path, brew)
    with sqlite3.connect(storage.path) as db:
        db.execute("CREATE TRIGGER reject_delete BEFORE DELETE ON beans BEGIN SELECT RAISE(ABORT, 'reject'); END")
    with pytest.raises(sqlite3.IntegrityError):
        storage.merge("beans", source["id"], target["id"])
    assert read_brew(tmp_path) == brew
    assert storage.get_record("123") == legacy
    assert len(storage.list_beans()) == 2


def test_catalog_edit_archive_delete_preserves_snapshots(tmp_path):
    storage = BeanStorage(tmp_path)
    bean = storage.save(name="Original", process="Natural", variety="Bourbon", roast_level="Light",
                        altitude="1800–2200 m", rating=4.5)
    grinder = storage.save_grinder(name="Hand grinder", notes="Burr set A")
    legacy = storage.record(bean["id"], "123", "14")
    brew = {"id": "brew", "bean_id": bean["id"], "bean_snapshot": bean,
            "grinder_id": grinder["id"], "grinder_snapshot": grinder}
    workspace_brew(tmp_path, brew)
    storage.save(bean["id"], name="Renamed", archived=True, rating=None)
    storage.save_grinder(grinder["id"], name="New name", archived=True)
    assert storage.list_beans()[0]["archived"] is True
    assert storage.list_beans()[0]["rating"] is None
    storage.delete(bean["id"])
    storage.delete_catalog("grinders", grinder["id"])
    assert storage.get_record("123") == legacy
    assert read_brew(tmp_path) == brew


def test_native_roundtrip_and_duplicate_policy(tmp_path):
    original = BeanStorage(tmp_path / "original")
    bean = original.save(name="Same name", rating=0, archived=True)
    original.save_grinder(name="Grinder")
    data = original.export_catalog()
    restored = BeanStorage(tmp_path / "restored")
    preview = restored.import_catalog(data, preview=True)
    assert restored.list_beans() == []
    restored.import_catalog(data, preview=False, preview_token=preview["preview_token"])
    assert restored.export_catalog() == data
    restored.save(bean["id"], notes="Local notes win")
    duplicate = {**bean, "id": "different-id"}
    data["beans"].append(duplicate)
    preview = restored.import_catalog(data, preview=True)
    assert preview["beans"] == {"added": 1, "skipped": 1, "matching_names": 1}
    restored.import_catalog(data, preview=False, preview_token=preview["preview_token"])
    by_id = {entry["id"]: entry for entry in restored.list_beans()}
    assert by_id[bean["id"]]["notes"] == "Local notes win"
    assert by_id["different-id"] == duplicate


def test_import_requires_current_preview(tmp_path):
    storage = BeanStorage(tmp_path)
    data = {"version": 1, "beans": [{"id": "new", "name": "New"}], "grinders": []}
    with pytest.raises(ValueError, match="Preview"):
        storage.import_catalog(data, preview=False)
    preview = storage.import_catalog(data, preview=True)
    storage.save(name="Concurrent edit")
    with pytest.raises(ValueError, match="Preview"):
        storage.import_catalog(data, preview=False, preview_token=preview["preview_token"])
    assert len(storage.list_beans()) == 1


@pytest.mark.parametrize("data", [
    {"beans": []},
    {"version": True, "beans": [], "grinders": []},
    {"version": 2, "beans": [], "grinders": []},
    {"version": 1, "beans": [], "grinders": [], "foreign_format": True},
    {"version": 1, "beans": [{"id": "a", "name": "Good"}, {"id": "b", "name": ""}], "grinders": []},
    {"version": 1, "beans": [{"id": "a", "name": "Good"}, {"id": "a", "name": "Repeated"}], "grinders": []},
    {"version": 1, "beans": [{"id": "a", "name": "Good", "rating": float("nan")}], "grinders": []},
    {"version": 1, "beans": [{"id": "a", "name": "Good", "unknown": "Rejected"}], "grinders": []},
])
def test_invalid_import_is_rejected_before_any_write(tmp_path, data):
    storage = BeanStorage(tmp_path)
    with pytest.raises(ValueError):
        storage.import_catalog(data, preview=True)
    assert storage.export_catalog() == {"version": 1, "beans": [], "grinders": []}


def test_import_write_failure_is_atomic(tmp_path):
    storage = BeanStorage(tmp_path)
    data = {"version": 1, "beans": [{"id": "bean", "name": "Bean"}],
            "grinders": [{"id": "grinder", "name": "Grinder"}]}
    preview = storage.import_catalog(data, preview=True)
    with sqlite3.connect(storage.path) as db:
        db.execute("CREATE TRIGGER reject_insert BEFORE INSERT ON grinders BEGIN SELECT RAISE(ABORT, 'reject'); END")
    with pytest.raises(sqlite3.IntegrityError):
        storage.import_catalog(data, preview=False, preview_token=preview["preview_token"])
    assert storage.export_catalog() == {"version": 1, "beans": [], "grinders": []}


def test_http_native_import_preview_apply_and_crud(tmp_path):
    app = Starlette(routes=routes)
    app.state.runtime = SimpleNamespace(data_dir=tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/library/beans", json={"name": "Coffee", "process": "Washed"})
        assert response.status_code == 200
        bean = response.json()["bean"]
        grinder = client.post("/api/library/grinders", json={"name": "Grinder"}).json()["grinder"]
        assert client.get("/api/library").json() == {"beans": [bean], "grinders": [grinder]}
        data = client.get("/api/library/export").json()
        assert client.post("/api/library/import", json={"data": data, "preview": False}).status_code == 422
        preview = client.post("/api/library/import", json={"data": data, "preview": True}).json()
        result = client.post("/api/library/import", json={"data": data, "preview": False,
                                                         "preview_token": preview["preview_token"]})
        assert result.status_code == 200
        assert result.json()["beans"]["skipped"] == 1
        assert client.post("/api/library/beans", json={"id": bean["id"], "archived": True}).json()["bean"]["archived"]
        assert client.post("/api/library/delete", json={"kind": "grinders", "id": grinder["id"]}).json()["success"]
        assert client.get("/api/library/merge").status_code == 405
        assert client.post("/api/library/import", json={"data": {"beans": []}, "preview": True}).status_code == 422
        assert client.post("/api/library/beans", content='{"name":"Wrong content type"}',
                           headers={"Content-Type": "text/plain"}).status_code == 415
        assert client.post("/api/library/import", content=b" " * 2_000_001,
                           headers={"Content-Type": "application/json"}).status_code == 413
