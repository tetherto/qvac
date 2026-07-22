"""Model-type normalization, alias handling, and modelSrc type inference.

Ports the JS SDK's `schemas/model-types.ts`, `schemas/engine-addon-map.ts`,
`schemas/model-src-utils.ts`, and `utils/load-model-validation.ts`. The wire
contract only accepts canonical `modelType` values ("llamacpp-completion",
...), so alias resolution ("llm" -> "llamacpp-completion") and inference from
a model descriptor's engine/addon happen client-side, before the request is
validated -- same as the JS client.
"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any

from ._generated.model_type_maps import (
    ALIAS_TO_CANONICAL,
    ENGINE_TO_ADDON,
)
from ._generated.model_type_maps import (
    LEGACY_ENGINE_TO_CANONICAL as _LEGACY_ENGINE_TO_CANONICAL,
)
from .errors import ModelSrcTypeMismatchError
from .schemas import ModelType

# The resolution data is generated from the SDK (contract/model-type-maps.json
# + the ModelType enum) so it can't drift from the TS client; only the thin
# resolution logic below is hand-written. See the drift-avoidance plan.

# Backward-compat aliases -> canonical values (ModelTypeAliases in JS).
MODEL_TYPE_ALIASES: dict[str, str] = ALIAS_TO_CANONICAL

# Canonical model types (the ModelType map in schemas/model-types.ts).
CANONICAL_MODEL_TYPES = frozenset(member.value for member in ModelType)

# What a descriptor's `engine` field may carry directly: the canonical engines
# plus "onnx-vad" (an engine but not a loadable modelType). These are exactly
# the ENGINE_TO_ADDON keys. "onnx-tts" routes to the GGML engine (below).
_REGISTRY_ENGINES = frozenset(ENGINE_TO_ADDON)


def is_canonical_model_type(value: str) -> bool:
    return value in CANONICAL_MODEL_TYPES


def is_model_type_alias(value: str) -> bool:
    return value in MODEL_TYPE_ALIASES


def is_builtin_model_type(value: Any) -> bool:
    """True for canonical names and aliases; False for custom plugin types."""
    return isinstance(value, str) and (
        value in CANONICAL_MODEL_TYPES or value in MODEL_TYPE_ALIASES
    )


def normalize_model_type(value: str) -> str:
    """Canonical form of a model type; custom plugin types pass through."""
    if value in CANONICAL_MODEL_TYPES:
        return value
    return MODEL_TYPE_ALIASES.get(value, value)


def resolve_canonical_engine(engine: str) -> str | None:
    """Any engine string (legacy or canonical) -> validated canonical engine,
    or None when unrecognized. Registry rows and cached metadata may still
    say "onnx-tts"; route those to the GGML engine."""
    if engine in _REGISTRY_ENGINES:
        return "tts-ggml" if engine == "onnx-tts" else engine
    return _LEGACY_ENGINE_TO_CANONICAL.get(engine)


def _descriptor_fields(model_src: Any) -> dict[str, Any] | None:
    if isinstance(model_src, dict):
        return model_src
    if is_dataclass(model_src) and not isinstance(model_src, type):
        # ModelConstant registry entries (tetherto.qvac_sdk.models) are frozen dataclasses.
        return asdict(model_src)
    return None


def infer_model_type_from_model_src(model_src: Any) -> str | None:
    """Infer the canonical model type from a descriptor's `engine` (then
    `addon`) field. Returns None for plain-string sources and descriptors
    with nothing recognizable -- the caller decides whether that's an error."""
    descriptor = _descriptor_fields(model_src)
    if descriptor is None:
        return None

    for key in ("engine", "addon"):
        value = descriptor.get(key)
        if isinstance(value, str) and value:
            canonical = resolve_canonical_engine(value)
            if canonical:
                return canonical
            if is_canonical_model_type(value) or is_model_type_alias(value):
                return normalize_model_type(value)

    return None


def assert_model_src_matches_model_type(
    model_src: Any, explicit_model_type: str
) -> None:
    """Raise ModelSrcTypeMismatchError when an explicit `model_type` disagrees
    with what `model_src` implies. No-op when nothing can be inferred."""
    inferred = infer_model_type_from_model_src(model_src)
    if not inferred:
        return
    normalized_inferred = normalize_model_type(inferred)
    normalized_explicit = normalize_model_type(explicit_model_type)
    if normalized_inferred != normalized_explicit:
        raise ModelSrcTypeMismatchError(normalized_inferred, normalized_explicit)


def model_src_to_wire(model_src: Any) -> Any:
    """The wire `modelSrc` is a plain string; a descriptor (dict or
    ModelConstant) contributes its `src` field. Strings pass through."""
    descriptor = _descriptor_fields(model_src)
    if descriptor is not None and isinstance(descriptor.get("src"), str):
        return descriptor["src"]
    return model_src


__all__ = [
    "CANONICAL_MODEL_TYPES",
    "MODEL_TYPE_ALIASES",
    "is_canonical_model_type",
    "is_model_type_alias",
    "is_builtin_model_type",
    "normalize_model_type",
    "resolve_canonical_engine",
    "infer_model_type_from_model_src",
    "assert_model_src_matches_model_type",
    "model_src_to_wire",
]
