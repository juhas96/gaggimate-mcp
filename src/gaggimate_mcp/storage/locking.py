"""Process-safe locks shared by local persistence and device note updates."""

import asyncio
import os
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

if os.name == "nt":
    import msvcrt
else:
    import fcntl


def _acquire(handle, blocking: bool) -> None:
    if os.name == "nt":
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))


def _release(handle) -> None:
    if os.name == "nt":
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _open_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    if path.stat().st_size == 0:
        handle.write(b"\0")
        handle.flush()
    return handle


@contextmanager
def file_lock(path: Path):
    with _open_lock(path) as handle:
        _acquire(handle, blocking=True)
        try:
            yield
        finally:
            _release(handle)


@asynccontextmanager
async def async_file_lock(path: Path):
    """Wait without blocking the event loop; cancellation never leaks a lock."""
    with _open_lock(path) as handle:
        while True:
            try:
                _acquire(handle, blocking=False)
                break
            except (BlockingIOError, PermissionError):
                await asyncio.sleep(0.05)
        try:
            yield
        finally:
            _release(handle)
