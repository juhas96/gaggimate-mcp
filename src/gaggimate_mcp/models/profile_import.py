"""Validate raw firmware Pro profiles without reconstructing or dropping fields."""

import math
from typing import Any


def _number(value: Any, path: str, minimum: float | None = None, maximum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{path} must be a finite number")
    if minimum is not None and value < minimum:
        raise ValueError(f"{path} must be at least {minimum}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{path} must be at most {maximum}")
    return value


def _name(value: Any, path: str):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 100:
        raise ValueError(f"{path} must be a nonblank string of at most 100 characters")


def _object(value: Any, path: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    return value


def _enum(value: Any, choices: tuple[str, ...], path: str):
    if not isinstance(value, str) or value not in choices:
        raise ValueError(f"{path} must be one of {', '.join(choices)}")


def _finite_tree(value: Any, path: str):
    # json.loads permits NaN/Infinity and overflowing exponents even inside unknown
    # extension fields. Preserve extensions, but never send non-JSON numbers.
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{path} must contain only finite numbers")
    if isinstance(value, dict):
        for key, child in value.items():
            _finite_tree(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _finite_tree(child, f"{path}[{index}]")


def imported_profile(profile_data: dict, suffix: str) -> dict:
    """Return a validated new-copy payload, retaining all original firmware fields."""
    profile = dict(_object(profile_data, "profile_data"))
    _finite_tree(profile, "profile")
    _name(profile.get("label"), "label")
    _enum(profile.get("type"), ("pro",), "type")
    _number(profile.get("temperature"), "temperature", 60, 100)
    if "description" in profile and not isinstance(profile["description"], str):
        raise ValueError("description must be a string")
    phases = profile.get("phases")
    if not isinstance(phases, list) or not 1 <= len(phases) <= 50:
        raise ValueError("phases must contain 1–50 phase objects")
    for index, raw_phase in enumerate(phases):
        path = f"phases[{index}]"
        phase = _object(raw_phase, path)
        _name(phase.get("name"), path + ".name")
        _enum(phase.get("phase"), ("preinfusion", "brew", "decline"), path + ".phase")
        if _number(phase.get("duration"), path + ".duration", 0, 120) == 0:
            raise ValueError(f"{path}.duration must be greater than zero")
        if _number(phase.get("valve"), path + ".valve", 0, 1) not in (0, 1):
            raise ValueError(f"{path}.valve must be 0 or 1")
        if "temperature" in phase:
            temperature = _number(phase["temperature"], path + ".temperature")
            if temperature != 0 and not 60 <= temperature <= 100:
                raise ValueError(f"{path}.temperature must be 0 or between 60 and 100")
        pump = phase.get("pump")
        if isinstance(pump, dict):
            _enum(pump.get("target"), ("pressure", "flow", "power", "off"), path + ".pump.target")
            power = pump["target"] == "power"
            _number(pump.get("pressure"), path + ".pump.pressure", 0 if power else -1, 100 if power else 12)
            _number(pump.get("flow"), path + ".pump.flow", -1)
        else:
            _number(pump, path + ".pump", 0, 100)
        transition = _object(phase.get("transition"), path + ".transition")
        _enum(transition.get("type"), ("instant", "linear", "ease-in", "ease-out", "ease-in-out"), path + ".transition.type")
        _number(transition.get("duration"), path + ".transition.duration", 0)
        if "adaptive" in transition and not isinstance(transition["adaptive"], bool):
            raise ValueError(f"{path}.transition.adaptive must be a boolean")
        if "targets" in phase:
            if not isinstance(phase["targets"], list):
                raise ValueError(f"{path}.targets must be an array")
            for target_index, raw_target in enumerate(phase["targets"]):
                target_path = f"{path}.targets[{target_index}]"
                target = _object(raw_target, target_path)
                _enum(target.get("type"), ("pressure", "flow", "volumetric", "pumped"), target_path + ".type")
                _enum(target.get("operator"), ("gte", "lte"), target_path + ".operator")
                _number(target.get("value"), target_path + ".value")
    profile["id"] = "new"
    profile["selected"] = False
    if not profile["label"].endswith(suffix):
        profile["label"] += suffix
    return profile
