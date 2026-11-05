"""Run the app-owned local backend: python -m gaggimate_mcp.desktop."""

import argparse
import os
from pathlib import Path

import uvicorn

from .app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="Gaggimate Desktop local backend")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--resource-dir", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--data-dir", type=Path)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    resource_dir = args.resource_dir.resolve()
    data_dir = (args.data_dir or resource_dir / "data").resolve()
    token = os.environ.get("GAGGIMATE_DESKTOP_TOKEN", "")
    if len(token) < 32:
        parser.error("Set GAGGIMATE_DESKTOP_TOKEN to a random token of at least 32 characters.")
    app = create_app(token=token, resource_dir=resource_dir, data_dir=data_dir)
    # Binding and Host validation are not configurable: the token authenticates a
    # local desktop client, never a remotely exposed server. Access logs are off.
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)


if __name__ == "__main__":
    main()
