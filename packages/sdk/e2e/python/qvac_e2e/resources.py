"""Resource key -> model, and the load/evict lifecycle around a test."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from tetherto.qvac_sdk import load_model, unload_model
from tetherto.qvac_sdk import models as model_constants

# The shared table, relative to this client. Overridable so a run can point at a catalog
# somewhere else without editing code.
_TABLE_PATH = Path(
    os.environ.get("QVAC_RESOURCE_TABLE")
    or Path(__file__).resolve().parents[2]
    / "tests"
    / "resources"
    / "resource-table.json"
)

# Where `$asset` placeholders point on this platform.
ASSET_ROOT = Path(
    os.environ.get("QVAC_ASSET_ROOT") or Path(__file__).resolve().parents[2] / "assets"
)

_PLATFORM = os.environ.get("QVAC_RESOURCE_PLATFORM", "desktop")


class MissingResourceTableError(RuntimeError):
    pass


def _load_table() -> dict[str, dict[str, Any]]:
    if not _TABLE_PATH.exists():
        raise MissingResourceTableError(f"the resource table is missing: {_TABLE_PATH}")
    table = json.loads(_TABLE_PATH.read_text())
    # `on` narrows a key to the platforms that define it; absent means all.
    return {
        dep: entry
        for dep, entry in table.items()
        if _PLATFORM in entry.get("on", [_PLATFORM])
    }


def _config_for(definition: dict[str, Any]) -> Any:
    """The entry's config with this platform's overrides merged over it."""
    config = definition.get("config")
    overrides = definition.get("configOn") or {}
    if not overrides:
        return config

    segments = _PLATFORM.split("-")

    def applies(name: str) -> bool:
        if name == _PLATFORM:
            return True
        parts = name.split("-")
        return len(parts) < len(segments) and all(
            part == segments[index] for index, part in enumerate(parts)
        )

    merged = dict(config or {})
    for name, patch in overrides.items():
        if applies(name):
            merged.update(patch)
    return merged or None


_RESOURCES: dict[str, dict[str, Any]] | None = None


def resources() -> dict[str, dict[str, Any]]:
    """The table, read once. A missing file fails the run here, not per test."""
    global _RESOURCES
    if _RESOURCES is None:
        _RESOURCES = _load_table()
    return _RESOURCES


class MissingConstantError(LookupError):
    pass


def _resolve(value: Any) -> Any:
    """Replace `$const` and `$asset` placeholders, recursively."""
    if isinstance(value, list):
        return [_resolve(item) for item in value]
    if isinstance(value, dict):
        name = value.get("$const")
        if isinstance(name, str):
            constant = getattr(model_constants, name, None)
            if constant is None:
                raise MissingConstantError(
                    f'model constant "{name}" is missing from the Python registry'
                )
            return constant
        asset = value.get("$asset")
        if isinstance(asset, dict):
            base = (ASSET_ROOT / asset["kind"]).resolve()
            resolved = (base / asset["file"]).resolve()
            # Same containment rule as the `asset` step: the table is shared data, so a
            # fixture name that climbs out of its root is refused.
            if base != resolved and base not in resolved.parents:
                raise MissingConstantError(
                    f'asset "{asset["file"]}" resolves outside the '
                    f'"{asset["kind"]}" asset root'
                )
            return str(resolved)
        return {key: _resolve(item) for key, item in value.items()}
    return value


class UnknownResourceError(LookupError):
    pass


class ResourceManager:
    """Loads models on demand and evicts what a test did not declare."""

    def __init__(self, transport: Any, log) -> None:
        self._transport = transport
        self._log = log
        self._loaded: dict[str, str] = {}

    @property
    def transport(self) -> Any:
        return self._transport

    def _definition(self, dep: str) -> dict[str, Any]:
        definition = resources().get(dep)
        if definition is None:
            raise UnknownResourceError(
                f'resource "{dep}" is not defined for platform "{_PLATFORM}" in '
                f"{_TABLE_PATH.name}"
            )
        return definition

    def source_of(self, dep: str) -> dict[str, Any]:
        """What `loadModel` would be called with for this key, without calling it."""
        definition = self._definition(dep)
        try:
            source = _resolve(definition.get("constant"))
        except MissingConstantError as error:
            raise UnknownResourceError(str(error)) from error
        out: dict[str, Any] = {}
        if source is not None:
            out["modelSrc"] = source
        if definition.get("modelSrc") is not None:
            out["modelSrc"] = definition["modelSrc"]
        if definition.get("type"):
            out["modelType"] = definition["type"]
        # Without the config a test driving the load path itself gets a source that
        # loads a different model than the key names -- a Bergamot pair with no
        # engine/from/to, for instance.
        config = _config_for(definition)
        if config is not None:
            out["modelConfig"] = config
        return out

    async def ensure_loaded(self, dep: str) -> str:
        existing = self._loaded.get(dep)
        if existing:
            return existing

        definition = self._definition(dep)
        try:
            constant = _resolve(definition.get("constant"))
            config = _resolve(_config_for(definition))
        except MissingConstantError as error:
            raise UnknownResourceError(str(error)) from error

        self._log(f"loading {dep}")
        model_id = await load_model(
            self._transport,
            model_src=constant if constant is not None else definition.get("modelSrc"),
            model_type=definition.get("type"),
            model_config=config,
        )
        self._loaded[dep] = model_id
        return model_id

    async def evict(self, dep: str) -> None:
        """Unload one resource and forget it."""
        model_id = self._loaded.pop(dep, None)
        if model_id is None:
            return
        self._log(f"evicting {dep}")
        try:
            await unload_model(self._transport, model_id)
        except Exception as error:  # noqa: BLE001 - eviction must not fail a test
            self._log(f"evicting {dep} failed (continuing): {error}")

    async def evict_all_except(self, keep: set[str]) -> None:
        for dep in [d for d in self._loaded if d not in keep]:
            model_id = self._loaded.pop(dep)
            self._log(f"evicting {dep}")
            try:
                await unload_model(self._transport, model_id)
            except Exception as error:  # noqa: BLE001 - eviction must not fail a test
                self._log(f"evicting {dep} failed (continuing): {error}")

    async def close(self) -> None:
        await self.evict_all_except(set())
