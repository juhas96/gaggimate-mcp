"""Local journal and machine-scoped MCP orchestration; no device protocol here."""

from __future__ import annotations

import asyncio
import json
import math
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictBool, field_validator
from starlette.exceptions import HTTPException

from gaggimate_mcp.config import GaggimateConfig
from gaggimate_mcp.storage.beans import BeanStorage, normalize_shot_id, timestamp
from gaggimate_mcp.storage.ratings import RatingStorage
from .bridge import MCPBridge

Number = Annotated[float, Field(strict=True, allow_inf_nan=False, gt=0)]
Name = Annotated[str, Field(min_length=1, max_length=200)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SyncInput(Input):
    offset: Annotated[int, Field(strict=True, ge=0)] = 0


class NotesInput(Input):
    bean_id: str | None = None
    grinder_id: str | None = None
    grind_setting: str = Field(default="", max_length=200)
    dose_in: Number | None = None
    dose_out: Number | None = None
    rating: Annotated[int, Field(strict=True, ge=0, le=5)] | None = None
    balance_taste: Literal["", "bitter", "balanced", "sour"] = ""
    notes: str = Field(default="", max_length=2000)
    sync_to_device: StrictBool = False


class ManualInput(NotesInput):
    id: str | None = None
    source: Literal["manual"] = "manual"
    brewer_id: Name
    recipe_id: str | None = None
    brewed_at: AwareDatetime
    profile: str = Field(default="", max_length=200)
    duration_seconds: Number | None = None
    temperature_c: Annotated[float, Field(strict=True, allow_inf_nan=False, ge=0, le=200)] | None = None

    @field_validator("brewed_at", mode="before")
    @classmethod
    def iso_brew_date(cls, value):
        if not isinstance(value, str):
            raise ValueError("brewed_at must be an ISO date-time with a timezone")
        return datetime.fromisoformat(value.replace("Z", "+00:00"))


class BrewerInput(Input):
    id: str | None = None
    name: Name
    method: Name


class RecipeInput(Input):
    id: str | None = None
    name: Name
    brewer_id: Name
    dose_in: Number | None = None
    dose_out: Number | None = None
    duration_seconds: Number | None = None
    temperature_c: Annotated[float, Field(strict=True, allow_inf_nan=False, ge=0, le=200)] | None = None
    notes: str = Field(default="", max_length=2000)


class MachineInput(Input):
    id: str | None = None
    name: Name
    host: Name

    @field_validator("host", mode="before")
    @classmethod
    def valid_host(cls, value: str) -> str:
        from .app import DesktopSettings
        return DesktopSettings(host=value).host


def public(brew: dict) -> dict:
    return {key: value for key, value in brew.items() if not key.startswith("_")}


def empty_brew(identifier: str, *, machine_id: str | None = None, shot_id: str | None = None) -> dict:
    return {
        "id": identifier, "source": "device" if machine_id else "manual",
        "machine_id": machine_id, "shot_id": shot_id, "brewed_at": "", "profile": "",
        "brewer_id": None, "recipe_id": None, "duration_seconds": None,
        "temperature_c": None, "dose_in": None, "dose_out": None,
        "bean_id": None, "bean_name": "", "bean_snapshot": None,
        "grinder_id": None, "grinder_name": "", "grinder_snapshot": None,
        "grind_setting": "", "rating": None, "balance_taste": "", "notes": "",
        "analysis": None, "sync_status": "local", "sync_error": None,
    }


def shot_key(machine_id: str, shot_id: str) -> str:
    return f"device:{machine_id}:{normalize_shot_id(shot_id)}"


def finite(value: Any) -> float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def shot_time(value: Any) -> str:
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value, timezone.utc).isoformat()
    if isinstance(value, str) and value:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Shot timestamp has no timezone")
        return parsed.isoformat()
    return ""  # Old backups do not contain a brew date; never invent one.


class Workspace:
    def __init__(self, runtime):
        self.runtime = runtime
        self.directory: Path = runtime.data_dir
        self.path = self.directory / "workspace.sqlite3"
        self.catalog = BeanStorage(self.directory)
        self.bridges: dict[str, MCPBridge] = {}
        self.sync_locks: dict[str, asyncio.Lock] = {}
        with self.transaction() as db:
            for table in ("machines", "brews", "brewers", "recipes"):
                db.execute(f"CREATE TABLE IF NOT EXISTS {table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
            if self.get(db, "machines", "default") is None:
                self.put(db, "machines", {"id": "default", "name": "Gaggimate", "host": runtime.settings.host})
        self.migrate_legacy()

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            db.execute("ATTACH DATABASE ? AS catalog", (str(self.catalog.path),))
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def get(db, table: str, identifier: str) -> dict | None:
        row = db.execute(f"SELECT data FROM {table} WHERE id = ?", (identifier,)).fetchone()
        return json.loads(row[0]) if row else None

    @staticmethod
    def put(db, table: str, value: dict):
        db.execute(f"INSERT OR REPLACE INTO {table} (id, data) VALUES (?, ?)",
                   (value["id"], json.dumps(value, allow_nan=False)))

    def require(self, db, table: str, identifier: str) -> dict:
        value = self.get(db, table, identifier)
        if value is None:
            raise HTTPException(404, f"{table.rstrip('s').capitalize()} not found.")
        return value

    def migrate_legacy(self):
        # Backups remain untouched. Missing dates/telemetry stay unknown until catch-up.
        ratings = RatingStorage(GaggimateConfig(storage_path=self.directory)).list_ratings()
        with self.transaction() as db:
            records = [json.loads(row[0]) for row in db.execute("SELECT data FROM catalog.bean_records")]
            merged: dict[str, dict] = {}
            for rating in ratings:
                sid = normalize_shot_id(rating["shot_id"])
                brew = merged.setdefault(sid, empty_brew(shot_key("default", sid), machine_id="default", shot_id=sid))
                for field in ("dose_in", "dose_out", "rating", "balance_taste", "notes", "grind_setting"):
                    if rating.get(field) is not None:
                        brew[field] = rating[field]
                brew["bean_name"] = rating.get("bean_type") or ""
                brew["_legacy_rating"] = rating
                brew["_device_patch"] = {key: rating[key] for key in
                                         ("dose_in", "dose_out", "rating", "balance_taste", "notes", "grind_setting", "bean_type")
                                         if rating.get(key) is not None and rating.get(key) != ""}
            for record in records:
                sid = normalize_shot_id(record["shot_id"])
                brew = merged.setdefault(sid, empty_brew(shot_key("default", sid), machine_id="default", shot_id=sid))
                for field in ("bean_id", "bean_name", "bean_snapshot", "grind_setting", "sync_status", "sync_error"):
                    if field in record:
                        brew[field] = record[field]
                if record.get("sync_status") != "synced":
                    brew["_device_patch"] = {**brew.get("_device_patch", {}),
                                             "bean_type": brew["bean_name"], "grind_setting": brew["grind_setting"]}
                brew["_legacy_record"] = record
            for brew in merged.values():
                if self.get(db, "brews", brew["id"]) is None:
                    self.put(db, "brews", brew)

    def snapshot(self) -> dict:
        with self.transaction() as db:
            result = {table: [public(json.loads(row[0])) for row in db.execute(f"SELECT data FROM {table}")]
                      for table in ("machines", "brews", "brewers", "recipes")}
        result["brews"].sort(key=lambda value: (value["brewed_at"], value["id"]), reverse=True)
        return result

    def check_default_host(self, host: str):
        self.migrate_legacy()
        with self.transaction() as db:
            machine = self.require(db, "machines", "default")
            if machine["host"] == host:
                return
            if self.sync_locks.get("default") and self.sync_locks["default"].locked():
                raise HTTPException(409, "Wait for default-machine history sync before changing its address.")
            if self.runtime.bridge.device_lock.locked():
                raise HTTPException(409, "Wait for the current device operation before changing its address.")
            if any(json.loads(row[0])["host"].casefold() == host.casefold() and row[1] != "default"
                   for row in db.execute("SELECT data,id FROM machines")):
                raise HTTPException(409, "A machine with this host already exists.")
            has_history = any(json.loads(row[0]).get("machine_id") == "default"
                              for row in db.execute("SELECT data FROM brews"))
            if has_history:
                raise HTTPException(409, "Default machine has saved history. Add another machine, or explicitly edit the existing machine address in Machines.")

    def update_default_host(self, host: str):
        with self.transaction() as db:
            machine = self.require(db, "machines", "default")
            machine["host"] = host
            self.put(db, "machines", machine)

    def machine(self, identifier: str) -> dict:
        with self.transaction() as db:
            return self.require(db, "machines", identifier)

    def bridge(self, identifier: str) -> MCPBridge:
        machine = self.machine(identifier)
        if identifier == "default":
            if machine["host"] != self.runtime.settings.host:
                raise HTTPException(409, "Configured host differs from the saved default machine. Explicitly update its address in Machines before accessing the device; saved history is still available offline.")
            return self.runtime.bridge
        current = self.bridges.get(identifier)
        if current is None or current.host != machine["host"]:
            current = MCPBridge(self.runtime.resource_dir, self.directory / "machines" / identifier, machine["host"])
            self.bridges[identifier] = current
        return current

    def save_machine(self, payload: MachineInput) -> dict:
        self.runtime.require_idle()
        with self.transaction() as db:
            if payload.id:
                self.require(db, "machines", payload.id)
            identifier = payload.id or str(uuid4())
            if self.sync_locks.get(identifier) and self.sync_locks[identifier].locked():
                raise HTTPException(409, "Wait for this machine's history sync to finish before changing its address.")
            current_bridge = self.runtime.bridge if identifier == "default" else self.bridges.get(identifier)
            if current_bridge is not None and current_bridge.device_lock.locked():
                raise HTTPException(409, "Wait for the current device operation before changing its address.")
            value = {"id": identifier, "name": payload.name, "host": payload.host}
            if any(json.loads(row[0])["host"].casefold() == payload.host.casefold() and row[1] != identifier
                   for row in db.execute("SELECT data,id FROM machines")):
                raise HTTPException(409, "A machine with this host already exists.")
            self.put(db, "machines", value)
            if identifier == "default":
                from .auth import atomic_private_json
                settings = self.runtime.settings.model_copy(update={"host": payload.host})
                atomic_private_json(self.runtime.settings_path, settings.model_dump())
                self.runtime.settings = settings
                self.runtime.bridge.host = payload.host
            return value

    def save_brewer(self, payload: BrewerInput) -> dict:
        with self.transaction() as db:
            if payload.id:
                self.require(db, "brewers", payload.id)
            value = {**payload.model_dump(), "id": payload.id or str(uuid4())}
            self.put(db, "brewers", value)
            return value

    def save_recipe(self, payload: RecipeInput) -> dict:
        with self.transaction() as db:
            self.require(db, "brewers", payload.brewer_id)
            if payload.id:
                previous = self.require(db, "recipes", payload.id)
                if previous["brewer_id"] != payload.brewer_id and any(
                    json.loads(row[0]).get("recipe_id") == payload.id for row in db.execute("SELECT data FROM brews")
                ):
                    raise HTTPException(409, "A used recipe's brewer cannot change; create another recipe instead.")
            value = {**payload.model_dump(), "id": payload.id or str(uuid4())}
            self.put(db, "recipes", value)
            return value

    def apply_notes(self, db, brew: dict, changes: dict):
        for kind in ("bean", "grinder"):
            field = kind + "_id"
            if field not in changes:
                continue
            identifier = changes.pop(field) or None
            if identifier == brew[field]:
                continue  # Catalog edits and merges must never rewrite historical snapshots.
            if identifier:
                entity = self.require(db, "catalog." + kind + "s", identifier)
                brew[field] = identifier
                brew[kind + "_name"] = entity["name"]
                brew[kind + "_snapshot"] = entity
            else:
                brew[field] = None
                brew[kind + "_name"] = ""
                brew[kind + "_snapshot"] = None
        brew.update(changes)

    def legacy_record(self, db, brew: dict):
        if brew["machine_id"] != "default":
            return
        sid = brew["shot_id"]
        row = db.execute("SELECT data FROM catalog.bean_records WHERE shot_id = ?", (sid,)).fetchone()
        if not brew["bean_id"]:
            db.execute("DELETE FROM catalog.bean_records WHERE shot_id = ?", (sid,))
            return
        old = json.loads(row[0]) if row else {}
        now = timestamp()
        record = {**old, **{field: brew[field] for field in
                  ("shot_id", "bean_id", "bean_name", "bean_snapshot", "grind_setting", "sync_status", "sync_error")},
                  "created_at": old.get("created_at", now), "updated_at": now,
                  "synced_at": now if brew["sync_status"] == "synced" else None}
        db.execute("INSERT OR REPLACE INTO catalog.bean_records VALUES (?, ?)", (sid, json.dumps(record, allow_nan=False)))

    def save_manual(self, payload: ManualInput) -> dict:
        if payload.sync_to_device:
            raise HTTPException(422, "Manual brews cannot be synced to a device.")
        with self.transaction() as db:
            self.require(db, "brewers", payload.brewer_id)
            brew = self.require(db, "brews", payload.id) if payload.id else empty_brew("manual:" + str(uuid4()))
            if brew["source"] != "manual":
                raise HTTPException(409, "Device brews cannot be replaced by manual brews.")
            recipe_id = payload.recipe_id if "recipe_id" in payload.model_fields_set else brew["recipe_id"]
            if recipe_id:
                recipe = self.require(db, "recipes", recipe_id)
                if recipe["brewer_id"] != payload.brewer_id:
                    raise HTTPException(422, "Recipe belongs to another brewer.")
            changes = payload.model_dump(mode="json", exclude_unset=True, exclude={"id", "sync_to_device", "source", "profile"})
            if not payload.id or recipe_id != brew["recipe_id"]:
                brew["profile"] = recipe["name"] if recipe_id else ""
            self.apply_notes(db, brew, changes)
            self.put(db, "brews", brew)
            return public(brew)

    async def notes(self, identifier: str, payload: NotesInput) -> dict:
        with self.transaction() as db:
            brew = self.require(db, "brews", identifier)
            if payload.sync_to_device and brew["source"] != "device":
                raise HTTPException(422, "Manual brews cannot be synced to a device.")
            changes = payload.model_dump(exclude_unset=True, exclude={"sync_to_device"})
            brew["_edited_fields"] = sorted(set(brew.get("_edited_fields", [])) | set(changes))
            device_patch = {key: value for key, value in changes.items()
                            if key not in {"bean_id", "grinder_id"} and value != brew.get(key)}
            bean_changed = "bean_id" in changes and (changes["bean_id"] or None) != brew["bean_id"]
            self.apply_notes(db, brew, changes)
            if bean_changed:
                device_patch["bean_type"] = brew["bean_name"]
            if brew["source"] == "device":
                brew["_device_patch"] = {**brew.get("_device_patch", {}), **device_patch}
                if device_patch:
                    brew.update(sync_status="pending", sync_error=None)
            self.put(db, "brews", brew)
            self.legacy_record(db, brew)
        if not payload.sync_to_device:
            return {"brew": public(brew)}
        patch = dict(brew.get("_device_patch", {}))
        if not patch:
            return {"brew": public(brew)}
        error = None
        try:
            unsupported = [key for key, value in patch.items() if value is None or (key == "balance_taste" and value == "")]
            if unsupported:
                raise ValueError("Device notes API cannot clear " + ", ".join(unsupported) + "; local changes were saved. Set a value before retrying device sync.")
            if patch:
                result = await self.bridge(brew["machine_id"]).call_tool("manage_shot_notes", {
                    "shot_id": brew["shot_id"], "action": "update", "sync_to_device": True, **patch,
                })
                status = result.get("sync_status", {})
                if not status.get("device_synced"):
                    raise ValueError(status.get("device_error") or "Device did not confirm the notes update.")
        except Exception as exc:
            error = str(exc) or type(exc).__name__
        with self.transaction() as db:
            # A concurrent edit/merge may have happened while MCP was running.
            latest = self.require(db, "brews", identifier)
            remaining = dict(latest.get("_device_patch", {}))
            if error is None:
                for key, value in patch.items():
                    if key in remaining and remaining[key] == value:
                        del remaining[key]
            latest["_device_patch"] = remaining
            latest.update(sync_status="failed" if error else ("pending" if remaining else "synced"), sync_error=error)
            self.put(db, "brews", latest)
            self.legacy_record(db, latest)
        return {"brew": public(latest), **({"sync_error": error} if error else {})}

    async def sync(self, machine_id: str, offset: int = 0) -> dict:
        """Scan one index page, importing at most five uncached or pending entries."""
        offset = SyncInput(offset=offset).offset
        bridge = self.bridge(machine_id)
        lock = self.sync_locks.setdefault(machine_id, asyncio.Lock())
        if lock.locked():
            raise HTTPException(409, "History sync is already running for this machine.")
        imported, errors = 0, []
        attempted, examined = 0, 0
        seen: set[str] = set()
        async with lock:
            try:
                page = await bridge.call_tool("list_recent_shots", {"limit": 50, "offset": offset})
                if not isinstance(page, dict) or not isinstance(page.get("shots"), list):
                    raise ValueError("Device returned an invalid shot list.")
                shots = page["shots"]
            except Exception as exc:
                errors.append(f"History page {offset}: {str(exc) or type(exc).__name__}")
                return {"imported": 0, "errors": errors, "next_offset": None}
            for examined, item in enumerate(shots, start=1):
                attempted += 1
                sid = str(item.get("id", "")) if isinstance(item, dict) else ""
                try:
                    sid = normalize_shot_id(sid)
                    if sid in seen:
                        attempted -= 1
                        continue
                    seen.add(sid)
                    identifier = shot_key(machine_id, sid)
                    with self.transaction() as db:
                        previous = self.get(db, "brews", identifier)
                    cached = previous and previous.get("analysis") is not None and not previous["analysis"].get("incomplete")
                    if cached and previous.get("_metadata_synced"):
                        attempted -= 1
                        continue
                    analysis = previous["analysis"] if cached else await bridge.call_tool(
                        "analyze_shot", {"shot_id": sid, "detail": "time_series", "resolution_hz": 4})
                    if not isinstance(analysis, dict) or not isinstance(analysis.get("shot"), dict):
                        raise ValueError("Device returned invalid shot analysis.")
                    device_notes = None
                    try:
                        response = await bridge.call_tool("manage_shot_notes", {"shot_id": sid, "action": "get"})
                        if not isinstance(response, dict) or "notes" not in response:
                            raise ValueError("Device returned invalid shot notes.")
                        if response["notes"] is not None and not isinstance(response["notes"], dict):
                            raise ValueError("Device returned invalid shot notes.")
                        # The device reports null when no notes were ever saved.
                        device_notes = response["notes"] if response["notes"] is not None else {}
                    except Exception as exc:
                        errors.append(f"Shot {sid} notes: {str(exc) or type(exc).__name__}")
                    shot = analysis["shot"]
                    with self.transaction() as db:
                        existing = self.get(db, "brews", identifier)
                        brew = existing or empty_brew(identifier, machine_id=machine_id, shot_id=sid)
                        summary = shot.get("summary") or {}
                        has_temperature = any(finite(point.get("temperature_c")) is not None
                                              for point in (shot.get("time_series") or {}).get("points", []))
                        brew.update(analysis=analysis, brewed_at=shot_time(shot.get("timestamp", item.get("timestamp"))),
                                    profile=shot.get("profile_name") or "", duration_seconds=finite(shot.get("duration_seconds")),
                                    temperature_c=finite((summary.get("temperature") or {}).get("avg_c")) if has_temperature else None)
                        aliases = {"beanType": "bean_name", "grindSetting": "grind_setting",
                                   "doseIn": "dose_in", "doseOut": "dose_out", "balanceTaste": "balance_taste",
                                   "bean_type": "bean_name"}
                        metadata = {aliases.get(key, key): value for key, value in (device_notes or {}).items()}
                        metadata.update({aliases.get(key, key): value for key, value in (analysis.get("rating") or {}).items()
                                         if value is not None})
                        edited = set(brew.get("_edited_fields", [])) | set(brew.get("_device_patch", {}))
                        if "bean_id" in edited or "bean_type" in edited:
                            edited.add("bean_name")
                        legacy = {**brew.get("_legacy_rating", {}), **brew.get("_legacy_record", {})}
                        edited.update(aliases.get(key, key) for key, value in legacy.items()
                                      if value is not None and value != "")
                        for field in ("dose_in", "dose_out", "rating", "notes", "grind_setting", "balance_taste", "bean_name"):
                            if field in edited:
                                continue
                            value = metadata.get(field)
                            if value is not None:
                                if field in {"dose_in", "dose_out", "rating"}:
                                    value = finite(value)
                                elif not isinstance(value, str):
                                    continue
                                brew[field] = value
                        if brew["dose_out"] is None and "dose_out" not in edited:
                            brew["dose_out"] = finite(shot.get("final_weight_g"))
                        brew["_metadata_synced"] = device_notes is not None
                        self.put(db, "brews", brew)
                    imported += 1
                except Exception as exc:
                    errors.append(f"Shot {sid or '(missing ID)'}: {str(exc) or type(exc).__name__}")
                if attempted == 5:
                    break
        return {"imported": imported, "errors": errors,
                "next_offset": None if examined == len(shots) and len(shots) < 50 else offset + examined}


def workspace(runtime) -> Workspace:
    if not hasattr(runtime, "workspace"):
        runtime.workspace = Workspace(runtime)
    return runtime.workspace
