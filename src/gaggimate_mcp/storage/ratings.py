"""Atomic local backups of shot metadata, preserving unspecified fields."""

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from gaggimate_mcp.config import GaggimateConfig
from gaggimate_mcp.models.rating import ShotRating
from gaggimate_mcp.storage.beans import normalize_shot_id
from gaggimate_mcp.storage.locking import file_lock


class RatingStorage:
    """Read-modify-write under a process lock; never replace missing fields by null."""

    def __init__(self, config: Optional[GaggimateConfig] = None):
        self.config = config or GaggimateConfig()
        self.storage_path = Path(self.config.storage_path) / "ratings.json"
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path = self.storage_path.with_suffix(".lock")

    def _load(self) -> dict[str, dict]:
        if not self.storage_path.exists():
            return {}
        with self.storage_path.open() as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            raise ValueError("ratings.json must contain an object; refusing to overwrite it")
        return data

    def _save(self, data: dict[str, dict]) -> None:
        fd, temporary = tempfile.mkstemp(prefix=".ratings-", dir=self.storage_path.parent)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(data, handle, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.storage_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def save_rating(self, rating: ShotRating, device_notes: Optional[dict] = None) -> dict:
        """Merge all metadata, including unknown device fields, into the backup."""
        shot_id = normalize_shot_id(rating.shot_id).zfill(6)
        aliases = {"balanceTaste": "balance_taste", "grindSetting": "grind_setting",
                   "beanType": "bean_type", "doseIn": "dose_in", "doseOut": "dose_out"}
        with file_lock(self.lock_path):
            ratings = self._load()
            data = dict(ratings.get(shot_id, {}))
            if device_notes is not None:
                data.update({aliases.get(key, key): value for key, value in device_notes.items()})
            data.update(rating.model_dump(mode="json", exclude_none=True))
            data["shot_id"] = shot_id
            if data.get("dose_in") and data.get("dose_out"):
                data["ratio"] = round(data["dose_out"] / data["dose_in"], 3)
            data["timestamp"] = datetime.now(timezone.utc).isoformat()
            ratings[shot_id] = data
            self._save(ratings)
            return data

    def get_rating(self, shot_id: str) -> Optional[dict]:
        with file_lock(self.lock_path):
            return self._load().get(normalize_shot_id(shot_id).zfill(6))

    def list_ratings(self) -> list[dict]:
        with file_lock(self.lock_path):
            return list(self._load().values())

    def delete_rating(self, shot_id: str) -> bool:
        with file_lock(self.lock_path):
            ratings = self._load()
            if ratings.pop(normalize_shot_id(shot_id).zfill(6), None) is None:
                return False
            self._save(ratings)
            return True
