"""Transactional bean catalog and per-shot snapshots, independent of device uptime."""

import hashlib
import json
import math
import re
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import uuid4


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_shot_id(value: str | None) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,20}", value):
        raise ValueError("shot_id must contain 1–20 decimal digits")
    return str(int(value))


def text(value: str | None, field: str, limit: int, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{field} is required")
    if len(value) > limit:
        raise ValueError(f"{field} must be at most {limit} characters")
    return value


BEAN_FIELDS = {"name": 200, "roaster": 200, "origin": 200, "roast_date": 10,
               "notes": 2000, "process": 200, "variety": 200, "roast_level": 200,
               "altitude": 200}
GRINDER_FIELDS = {"name": 200, "notes": 2000}


def catalog_fields(kind: str, fields: dict) -> dict:
    limits = BEAN_FIELDS if kind == "beans" else GRINDER_FIELDS
    allowed = set(limits) | {"archived"} | ({"rating"} if kind == "beans" else set())
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Unknown catalog fields: {', '.join(sorted(unknown))}")
    updates = {key: text(value, key, limits[key], required=key == "name")
               for key, value in fields.items() if key in limits and value is not None}
    if updates.get("roast_date"):
        value = updates["roast_date"]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("roast_date must use YYYY-MM-DD")
        date.fromisoformat(value)
    if "rating" in fields:
        rating = fields["rating"]
        if rating is not None and (isinstance(rating, bool) or not isinstance(rating, (int, float))
                                   or not math.isfinite(rating) or not 0 <= rating <= 5):
            raise ValueError("rating must be a finite number from 0 to 5, or null")
        updates["rating"] = rating
    if "archived" in fields:
        if not isinstance(fields["archived"], bool):
            raise ValueError("archived must be a boolean")
        updates["archived"] = fields["archived"]
    return updates


def catalog_kind(kind: str) -> str:
    if kind not in ("beans", "grinders"):
        raise ValueError("kind must be beans or grinders")
    return kind


class BeanStorage:
    """Fresh connections and immediate transactions prevent lost cross-process writes."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "beans.sqlite3"
        with self._transaction() as db:
            db.execute("CREATE TABLE IF NOT EXISTS beans (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS bean_records (shot_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS grinders (id TEXT PRIMARY KEY, data TEXT NOT NULL)")

    @contextmanager
    def _transaction(self, workspace: bool = False):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            if workspace:
                db.execute("ATTACH DATABASE ? AS workspace", (str(self.directory / "workspace.sqlite3"),))
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def list_beans(self) -> list[dict]:
        with self._transaction() as db:
            beans = [json.loads(row[0]) for row in db.execute("SELECT data FROM beans")]
        return sorted(beans, key=lambda bean: (bean["name"].casefold(), bean["id"]))

    def save(self, bean_id: str | None = None, **fields) -> dict:
        updates = catalog_fields("beans", fields)
        with self._transaction() as db:
            if bean_id is not None:
                row = db.execute("SELECT data FROM beans WHERE id = ?", (bean_id,)).fetchone()
                if row is None:
                    raise ValueError("Bean not found")
                bean = json.loads(row[0])
            else:
                if not updates.get("name"):
                    raise ValueError("name is required when creating a bean")
                bean = {"id": str(uuid4()), "created_at": timestamp(),
                        **dict.fromkeys(BEAN_FIELDS, ""), "rating": None, "archived": False}
            bean.update(updates)
            bean["updated_at"] = timestamp()
            db.execute("INSERT OR REPLACE INTO beans VALUES (?, ?)", (bean["id"], json.dumps(bean)))
            return bean

    def delete(self, bean_id: str | None) -> bool:
        bean_id = text(bean_id, "bean_id", 200, required=True)
        with self._transaction() as db:
            return db.execute("DELETE FROM beans WHERE id = ?", (bean_id,)).rowcount > 0

    def list_grinders(self) -> list[dict]:
        with self._transaction() as db:
            grinders = [json.loads(row[0]) for row in db.execute("SELECT data FROM grinders")]
        return sorted(grinders, key=lambda grinder: (grinder["name"].casefold(), grinder["id"]))

    def save_grinder(self, grinder_id: str | None = None, **fields) -> dict:
        updates = catalog_fields("grinders", fields)
        with self._transaction() as db:
            if grinder_id is not None:
                row = db.execute("SELECT data FROM grinders WHERE id = ?", (grinder_id,)).fetchone()
                if row is None:
                    raise ValueError("Grinder not found")
                grinder = json.loads(row[0])
            else:
                if not updates.get("name"):
                    raise ValueError("name is required when creating a grinder")
                grinder = {"id": str(uuid4()), "created_at": timestamp(), "name": "", "notes": "",
                           "archived": False}
            grinder.update(updates)
            grinder["updated_at"] = timestamp()
            db.execute("INSERT OR REPLACE INTO grinders VALUES (?, ?)", (grinder["id"], json.dumps(grinder)))
            return grinder

    def delete_catalog(self, kind: str, identifier: str) -> bool:
        kind = catalog_kind(kind)
        identifier = text(identifier, "id", 200, required=True)
        with self._transaction() as db:
            return db.execute(f"DELETE FROM {kind} WHERE id = ?", (identifier,)).rowcount > 0

    def merge(self, kind: str, source_id: str, target_id: str) -> dict:
        """Move live associations atomically; never rewrite historical snapshots."""
        kind = catalog_kind(kind)
        source_id = text(source_id, "source_id", 200, required=True)
        target_id = text(target_id, "target_id", 200, required=True)
        if source_id == target_id:
            raise ValueError("Choose two different entries to merge")
        has_workspace = (self.directory / "workspace.sqlite3").exists()
        with self._transaction(workspace=has_workspace) as db:
            for identifier in (source_id, target_id):
                if db.execute(f"SELECT id FROM {kind} WHERE id = ?", (identifier,)).fetchone() is None:
                    raise ValueError("Both merge entries must exist")
            field = "bean_id" if kind == "beans" else "grinder_id"
            counts = {"brews": 0, "bean_records": 0}
            tables = [("bean_records", "shot_id")] if kind == "beans" else []
            if has_workspace and db.execute(
                "SELECT 1 FROM workspace.sqlite_master WHERE type = 'table' AND name = 'brews'"
            ).fetchone():
                tables.append(("workspace.brews", "id"))
            for table, key in tables:
                rows = db.execute(f"SELECT {key}, data FROM {table}").fetchall()
                for identifier, raw in rows:
                    record = json.loads(raw)
                    if record.get(field) == source_id:
                        record[field] = target_id
                        db.execute(f"UPDATE {table} SET data = ? WHERE {key} = ?",
                                   (json.dumps(record), identifier))
                        counts["brews" if table == "workspace.brews" else "bean_records"] += 1
            db.execute(f"DELETE FROM {kind} WHERE id = ?", (source_id,))
            return {"success": True, "updated": counts}

    def export_catalog(self) -> dict:
        with self._transaction() as db:
            return {"version": 1, **{
                kind: [json.loads(row[0]) for row in db.execute(f"SELECT data FROM {kind} ORDER BY id")]
                for kind in ("beans", "grinders")
            }}

    def import_catalog(self, data: dict, *, preview: bool, preview_token: str | None = None) -> dict:
        """Keep existing IDs unchanged; same-name entries with distinct IDs stay distinct."""
        if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1:
            raise ValueError("Expected a native library export with version 1")
        if set(data) != {"version", "beans", "grinders"}:
            raise ValueError("Native export must contain only version, beans and grinders")
        for kind in ("beans", "grinders"):
            if not isinstance(data[kind], list) or len(data[kind]) > 10000:
                raise ValueError(f"{kind} must be an array of at most 10000 entries")
            seen = set()
            for entry in data[kind]:
                if not isinstance(entry, dict):
                    raise ValueError(f"Each {kind} entry must be an object")
                identifier = text(entry.get("id"), "id", 200, required=True)
                if entry["id"] != identifier or identifier in seen:
                    raise ValueError(f"Invalid or repeated ID in {kind}: {identifier}")
                seen.add(identifier)
                fields = {key: value for key, value in entry.items()
                          if key not in {"id", "created_at", "updated_at"}}
                catalog_fields(kind, fields)
                text(entry.get("name"), "name", 200, required=True)
                for key in ("created_at", "updated_at"):
                    if key in entry:
                        value = text(entry[key], key, 80, required=True)
                        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                        if parsed.tzinfo is None:
                            raise ValueError(f"{key} must include a timezone")
        with self._transaction() as db:
            existing = {kind: {row[0]: json.loads(row[1]) for row in
                        db.execute(f"SELECT id, data FROM {kind} ORDER BY id")} for kind in ("beans", "grinders")}
            digest = hashlib.sha256(json.dumps(
                {"data": data, "existing": existing}, sort_keys=True, allow_nan=False
            ).encode()).hexdigest()
            report = {"preview": preview, "preview_token": digest,
                      "policy": "Existing IDs are kept unchanged; different IDs remain separate, even with matching names.",
                      "beans": {}, "grinders": {}}
            pending = []
            for kind in ("beans", "grinders"):
                added = skipped = matching_names = 0
                names = {entry["name"].strip().casefold() for entry in existing[kind].values()}
                for entry in data[kind]:
                    if entry["id"] in existing[kind]:
                        skipped += 1
                    else:
                        added += 1
                        name = entry["name"].strip().casefold()
                        matching_names += int(name in names)
                        names.add(name)
                        pending.append((kind, entry))
                report[kind] = {"added": added, "skipped": skipped, "matching_names": matching_names}
            if not preview:
                if preview_token != digest:
                    raise ValueError("Preview this file again before importing; the file or library has changed")
                for kind, entry in pending:
                    db.execute(f"INSERT INTO {kind} VALUES (?, ?)", (entry["id"], json.dumps(entry, allow_nan=False)))
            return report

    def record(self, bean_id: str, shot_id: str, grind_setting: str) -> dict:
        """Explicit corrections replace a snapshot; catalog edits never do."""
        shot_id = normalize_shot_id(shot_id)
        bean_id = text(bean_id, "bean_id", 200, required=True)
        grind_setting = text(grind_setting, "grind_setting", 200, required=True)
        with self._transaction() as db:
            previous = db.execute("SELECT data FROM bean_records WHERE shot_id = ?", (shot_id,)).fetchone()
            old = json.loads(previous[0]) if previous else None
            if old and old["bean_id"] == bean_id and old["grind_setting"] == grind_setting:
                return old
            row = db.execute("SELECT data FROM beans WHERE id = ?", (bean_id,)).fetchone()
            if row is None:
                raise ValueError("Bean not found")
            bean = json.loads(row[0])
            now = timestamp()
            record = {
                "shot_id": shot_id, "bean_id": bean_id, "bean_name": bean["name"],
                "bean_snapshot": bean, "grind_setting": grind_setting,
                "sync_status": "pending", "sync_error": None, "synced_at": None,
                "created_at": old["created_at"] if old else now, "updated_at": now,
            }
            db.execute("INSERT OR REPLACE INTO bean_records VALUES (?, ?)", (shot_id, json.dumps(record)))
            return record

    def get_record(self, shot_id: str) -> dict:
        shot_id = normalize_shot_id(shot_id)
        with self._transaction() as db:
            row = db.execute("SELECT data FROM bean_records WHERE shot_id = ?", (shot_id,)).fetchone()
            if row is None:
                raise ValueError("No bean record for this shot")
            return json.loads(row[0])

    def records(self, shot_id: str | None = None) -> list[dict]:
        if shot_id is not None:
            shot_id = normalize_shot_id(shot_id)
        with self._transaction() as db:
            rows = db.execute("SELECT data FROM bean_records" + (" WHERE shot_id = ?" if shot_id else ""),
                              (shot_id,) if shot_id else ())
            records = [json.loads(row[0]) for row in rows]
        return sorted(records, key=lambda record: record["updated_at"], reverse=True)

    def set_sync_status(self, shot_id: str, status: str, error: str | None = None) -> dict:
        if status not in {"pending", "failed", "synced"}:
            raise ValueError("Invalid sync status")
        with self._transaction() as db:
            row = db.execute("SELECT data FROM bean_records WHERE shot_id = ?", (shot_id,)).fetchone()
            if row is None:
                raise ValueError("No bean record for this shot")
            record = json.loads(row[0])
            record.update(sync_status=status, sync_error=error, updated_at=timestamp())
            record["synced_at"] = timestamp() if status == "synced" else None
            db.execute("UPDATE bean_records SET data = ? WHERE shot_id = ?", (json.dumps(record), shot_id))
            return record
