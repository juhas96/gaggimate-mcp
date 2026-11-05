"""Bean recording orchestration: save locally first, then attempt verified sync."""

from gaggimate_mcp.api.websocket import GaggimateWebSocketClient
from gaggimate_mcp.models.rating import ShotRating
from gaggimate_mcp.storage.beans import BeanStorage, normalize_shot_id, text
from gaggimate_mcp.storage.locking import async_file_lock
from gaggimate_mcp.storage.ratings import RatingStorage


class BeanRecorder:
    def __init__(self, storage: BeanStorage, device: GaggimateWebSocketClient, ratings: RatingStorage):
        self.storage = storage
        self.device = device
        self.ratings = ratings

    async def record(self, bean_id: str | None, shot_id: str | None, grind_setting: str | None) -> dict:
        shot_id = normalize_shot_id(shot_id)
        bean_id = text(bean_id, "bean_id", 200, required=True)
        grind_setting = text(grind_setting, "grind_setting", 200, required=True)
        async with async_file_lock(self.storage.directory / "locks" / f"bean-{shot_id}.lock"):
            record = self.storage.record(bean_id, shot_id, grind_setting)
            if record["sync_status"] == "synced":
                return record
            return await self._sync(record)

    async def sync(self, shot_id: str | None) -> dict:
        shot_id = normalize_shot_id(shot_id)
        async with async_file_lock(self.storage.directory / "locks" / f"bean-{shot_id}.lock"):
            return await self._sync(self.storage.get_record(shot_id))

    async def _sync(self, record: dict) -> dict:
        shot_id = record["shot_id"]
        self.storage.set_sync_status(shot_id, "pending")
        try:
            rating = ShotRating(shot_id=shot_id, bean_type=record["bean_name"],
                                grind_setting=record["grind_setting"])
            self.ratings.save_rating(rating)
            result = await self.device.save_shot_notes(
                shot_id=shot_id, bean_type=record["bean_name"], grind_setting=record["grind_setting"],
            )
            self.ratings.save_rating(rating, device_notes=result["notes"])
        except Exception as exc:
            return self.storage.set_sync_status(shot_id, "failed", str(exc) or type(exc).__name__)
        # Cancellation/termination leaves a durable pending record for explicit retry.
        return self.storage.set_sync_status(shot_id, "synced")
