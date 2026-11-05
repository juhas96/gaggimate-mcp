"""Authenticated desktop library routes; native JSON imports never contact a device."""

from functools import partial

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from gaggimate_mcp.storage.beans import BeanStorage, text


def operation(directory, action: str, body: dict) -> dict:
    storage = BeanStorage(directory)
    if action == "list":
        exported = storage.export_catalog()
        return {"beans": exported["beans"], "grinders": exported["grinders"]}
    if action == "export":
        return storage.export_catalog()
    if action in {"beans", "grinders"}:
        fields = dict(body)
        identifier = fields.pop("id", None)
        if identifier is not None:
            identifier = text(identifier, "id", 200, required=True)
        if action == "beans":
            return {"bean": storage.save(identifier, **fields)}
        return {"grinder": storage.save_grinder(identifier, **fields)}
    if action == "merge":
        if set(body) != {"kind", "source_id", "target_id"}:
            raise ValueError("Merge requires kind, source_id and target_id")
        return storage.merge(body["kind"], body["source_id"], body["target_id"])
    if action == "delete":
        if set(body) != {"kind", "id"}:
            raise ValueError("Delete requires kind and id")
        if not storage.delete_catalog(body["kind"], body["id"]):
            raise ValueError("Catalog entry not found")
        return {"success": True}
    if action == "import":
        if set(body) - {"data", "preview", "preview_token"} or type(body.get("preview")) is not bool:
            raise ValueError("Import requires data and a boolean preview flag")
        return storage.import_catalog(body.get("data"), preview=body["preview"],
                                      preview_token=body.get("preview_token"))
    raise ValueError("Unknown library operation")


async def library(request: Request):
    action = request.path_params.get("action", "list")
    expected = "GET" if action in {"list", "export"} else "POST"
    if action not in {"list", "export", "beans", "grinders", "merge", "delete", "import"}:
        return JSONResponse({"error": "Unknown library operation"}, status_code=404)
    if request.method != expected:
        return JSONResponse({"error": f"Use {expected} for this operation"}, status_code=405,
                            headers={"Allow": expected})
    try:
        body = {}
        if expected == "POST":
            from gaggimate_mcp.desktop.app import json_body

            body = await json_body(request)
        result = await run_in_threadpool(partial(operation, request.app.state.runtime.data_dir, action, body))
        headers = {"Content-Disposition": 'attachment; filename="gaggimate-library.json"'} if action == "export" else {}
        return JSONResponse(result, headers=headers)
    except (ValueError, TypeError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)


routes = [
    Route("/api/library", library, methods=["GET"]),
    Route("/api/library/{action}", library, methods=["GET", "POST"]),
]
