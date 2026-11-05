"""App-owned ChatGPT plan sign-in; never reads Codex or API-key credentials."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import tempfile
import uuid
import webbrowser
from dataclasses import asdict
from pathlib import Path

from pydantic_ai.providers.openai_chatgpt import (
    OpenAIChatGPTCredentials,
    OpenAIChatGPTCredentialSource,
    OpenAIChatGPTOAuthFlow,
    OpenAIChatGPTProvider,
)


def atomic_private_json(path: Path, value: object) -> None:
    """Replace a complete private file, never exposing a partially refreshed token."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class PrivateCredentialSource(OpenAIChatGPTCredentialSource):
    """A revocable source prevents an in-flight refresh resurrecting a logout."""

    def __init__(self, path: Path):
        self.path = path
        self.revoked = False

    async def load(self) -> OpenAIChatGPTCredentials:
        if self.revoked:
            raise PermissionError("ChatGPT sign-in was cleared.")
        # O_NOFOLLOW also prevents reading another app's credentials through a symlink.
        fd = os.open(self.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise PermissionError("The credential store must be a regular private file.")
            if os.name == "posix":
                if info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise PermissionError("The credential store must be owned by you with mode 0600.")
            data = json.load(stream)
        credentials = OpenAIChatGPTCredentials(**data)
        if not credentials.client_id or not credentials.access_token or not credentials.refresh_token:
            raise ValueError("Incomplete ChatGPT credentials. Sign in again.")
        return credentials

    async def save(self, credentials: OpenAIChatGPTCredentials) -> None:
        if self.revoked:
            raise PermissionError("ChatGPT sign-in was cleared.")
        atomic_private_json(self.path, asdict(credentials))

    def clear(self) -> None:
        self.revoked = True
        self.path.unlink(missing_ok=True)


class InstallationLock:
    """Only one refresh-token owner may run against an app data directory."""

    def __init__(self, directory: Path):
        self.path = directory / "instance.lock"
        self.file = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        self.file = os.fdopen(fd, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.file.write(b"0")
                self.file.flush()
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.release()
            raise RuntimeError("Another Gaggimate Desktop backend owns this data directory.") from None

    def release(self) -> None:
        if self.file is not None:
            self.file.close()
            self.file = None


class ChatGPTAuth:
    def __init__(self, directory: Path):
        self.directory = directory
        self.source = PrivateCredentialSource(directory / "chatgpt-credentials.json")
        self.provider: OpenAIChatGPTProvider | None = None
        self.status = "signed_out"
        self.error: str | None = None
        self.login_task: asyncio.Task | None = None

    @property
    def authenticated(self) -> bool:
        return self.status == "signed_in" and self.provider is not None

    async def initialize(self) -> None:
        if not self.source.path.exists():
            return
        try:
            credentials = await self.source.load()
            self._install_provider(credentials)
        except Exception:
            self.status = "error"
            self.error = "Cannot load private ChatGPT credentials. Sign out and sign in again."

    def _install_provider(self, credentials: OpenAIChatGPTCredentials) -> None:
        if not credentials.plan_usage_granted:
            self.status = "error"
            self.error = "ChatGPT plan usage was not granted. Sign in again and approve plan usage."
            self.provider = None
            return
        self.provider = OpenAIChatGPTProvider(credential_source=self.source)
        self.status = "signed_in"
        self.error = None

    def start_login(self) -> None:
        if self.login_task is not None and not self.login_task.done():
            return
        self.status = "pending"
        self.error = None
        self.login_task = asyncio.create_task(self._login())

    async def _login(self) -> None:
        callback: asyncio.Task | None = None
        try:
            host_path = self.directory / "host-id.json"
            if not host_path.exists():
                atomic_private_json(host_path, str(uuid.uuid4().urn))
            host_id = json.loads(host_path.read_text(encoding="utf-8"))
            saved = None
            if self.source.path.exists():
                saved = await self.source.load()
            flow = OpenAIChatGPTOAuthFlow(
                app_name="Gaggimate Studio",
                host_id=host_id,
                client_id=saved.client_id if saved else None,
                id_token_hint=saved.id_token if saved else None,
            )
            # Start the callback listener before opening the browser. No URL or token is
            # returned to the webview, added to a prompt, or written to application logs.
            async with asyncio.timeout(300):
                callback = asyncio.create_task(flow.exchange_code_from_callback())
                await asyncio.sleep(0)
                url = flow.authorization_url(
                    extra_params={"prompt": "consent"} if saved and not saved.plan_usage_granted else None
                )
                opened = await asyncio.to_thread(webbrowser.open, url)
                if not opened:
                    raise RuntimeError("browser_unavailable")
                credentials = await callback
                await self.source.save(credentials)
                await self._close_provider()
                self._install_provider(credentials)
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            self.status = "error"
            self.error = "ChatGPT sign-in timed out after five minutes. Try signing in again."
        except Exception as exc:
            self.status = "error"
            # Provider exceptions can contain a URL, code, or token response: never relay
            # arbitrary exception text from OAuth to a browser or log.
            if isinstance(exc, OSError):
                self.error = "ChatGPT sign-in could not open its callback on 127.0.0.1:1455 or save credentials. Close another sign-in and check app-data permissions."
            elif isinstance(exc, RuntimeError) and exc.args == ("browser_unavailable",):
                self.error = "Could not open your default browser. Configure a browser and try again."
            else:
                self.error = "ChatGPT sign-in was rejected or could not finish. Check your connection and approve plan usage, then try again."
        finally:
            if callback is not None:
                if not callback.done():
                    callback.cancel()
                await asyncio.gather(callback, return_exceptions=True)

    async def _close_provider(self) -> None:
        provider, self.provider = self.provider, None
        if provider is not None:
            await provider.client.close()

    async def logout(self) -> None:
        await self.cancel_login()
        self.status = "signed_out"
        self.error = None
        try:
            self.source.clear()
            self.source = PrivateCredentialSource(self.source.path)
        finally:
            await self._close_provider()

    async def cancel_login(self) -> None:
        if self.login_task is not None:
            self.login_task.cancel()
            await asyncio.gather(self.login_task, return_exceptions=True)
            self.login_task = None

    async def close(self) -> None:
        await self.cancel_login()
        await self._close_provider()
