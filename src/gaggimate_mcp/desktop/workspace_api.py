"""Authenticated workspace endpoints; all device access goes through MCPBridge."""

from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .workspace import BrewerInput, MachineInput, ManualInput, NotesInput, RecipeInput, SyncInput, workspace


async def body(request: Request):
    from .app import json_body
    return await json_body(request)


async def snapshot(request: Request):
    return JSONResponse(workspace(request.app.state.runtime).snapshot())


async def machine(request: Request):
    payload = MachineInput.model_validate(await body(request))
    return JSONResponse({"machine": workspace(request.app.state.runtime).save_machine(payload)})


async def sync(request: Request):
    payload = SyncInput.model_validate(await body(request))
    return JSONResponse(await workspace(request.app.state.runtime).sync(request.path_params["identifier"], payload.offset))


async def tool(request: Request):
    """Allow only profiles, shot reads and diagnostics; catalog/notes use journal APIs."""
    arguments = await body(request)
    name = request.path_params["name"]
    if name not in {"manage_profile", "analyze_shot", "list_recent_shots", "diagnose_connection"}:
        raise HTTPException(422, "This machine endpoint supports profiles, shot reads and diagnostics only. Use Library or journal notes endpoints for catalog and feedback changes.")
    service = workspace(request.app.state.runtime)
    return JSONResponse(await service.bridge(request.path_params["identifier"]).call_tool(request.path_params["name"], arguments))


async def manual(request: Request):
    payload = ManualInput.model_validate(await body(request))
    return JSONResponse({"brew": workspace(request.app.state.runtime).save_manual(payload)})


async def notes(request: Request):
    payload = NotesInput.model_validate(await body(request))
    return JSONResponse(await workspace(request.app.state.runtime).notes(request.path_params["identifier"], payload))


async def brewer(request: Request):
    payload = BrewerInput.model_validate(await body(request))
    return JSONResponse({"brewer": workspace(request.app.state.runtime).save_brewer(payload)})


async def recipe(request: Request):
    payload = RecipeInput.model_validate(await body(request))
    return JSONResponse({"recipe": workspace(request.app.state.runtime).save_recipe(payload)})


routes = [
    Route("/api/workspace", snapshot),
    Route("/api/workspace/machines", machine, methods=["POST"]),
    Route("/api/workspace/machines/{identifier}/sync", sync, methods=["POST"]),
    Route("/api/workspace/machines/{identifier}/tools/{name}", tool, methods=["POST"]),
    Route("/api/workspace/brews", manual, methods=["POST"]),
    Route("/api/workspace/brews/{identifier}/notes", notes, methods=["POST"]),
    Route("/api/workspace/brewers", brewer, methods=["POST"]),
    Route("/api/workspace/recipes", recipe, methods=["POST"]),
]
