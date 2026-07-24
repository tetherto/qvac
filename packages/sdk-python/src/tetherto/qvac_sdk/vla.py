"""VLA (vision-language-action) tensor marshaling over pluginInvoke.

Ports the JS SDK's `client/api/vla.ts` + `vla-helpers.ts`: numpy arrays are
base64-encoded into the `vlaRun` plugin request, the response's action chunk
is decoded back to float32, and `vla_preprocess_image` / `vla_pad_state`
mirror `@qvac/vla-ggml`'s preprocessing math so the wire-format tensors stay
byte-identical regardless of where preprocessing runs.

numpy ships as the optional `vla` extra; every entry point raises an
actionable error when it's missing.
"""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ._api import invoke_plugin
from ._transport import Transport

try:
    import numpy as np
except ImportError:  # the vla extra is optional
    np = None  # type: ignore[assignment]

NUMPY_AVAILABLE = np is not None

VLA_DEFAULT_IMAGE_SIZE = 512

_VLA_RUN_HANDLER = "vlaRun"
_VLA_HPARAMS_HANDLER = "vlaHparams"


class NumpyNotInstalledError(ImportError):
    def __init__(self) -> None:
        super().__init__(
            "numpy is not installed -- install the 'vla' extra "
            "(`pip install tetherto-qvac-sdk[vla]`) to use the VLA client surface"
        )


def _require_numpy() -> Any:
    if np is None:
        raise NumpyNotInstalledError()
    return np


# ---- Wire shapes (mirror schemas/vla.ts) ----------------------------------


class VlaHparams(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    chunk_size: int = Field(alias="chunkSize", ge=0)
    action_dim: int = Field(alias="actionDim", ge=0)
    max_action_dim: int = Field(alias="maxActionDim", ge=0)
    max_state_dim: int = Field(alias="maxStateDim", ge=0)
    tokenizer_max_length: int = Field(alias="tokenizerMaxLength", ge=0)
    vision_image_size: int = Field(alias="visionImageSize", ge=0)
    num_cameras: int | None = Field(alias="numCameras", default=None, gt=0)
    state_input_mode: str | None = Field(alias="stateInputMode", default=None)


class _VlaHparamsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    hparams: VlaHparams
    backend_name: str | None = Field(alias="backendName", default=None)


class _VlaRunResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    actions: str = Field(min_length=1)
    action_dim: int = Field(alias="actionDim", gt=0)
    chunk_size: int = Field(alias="chunkSize", gt=0)
    stats: dict[str, Any] | None = None


@dataclass(frozen=True)
class VlaRunResult:
    actions: Any  # np.ndarray[float32], length chunk_size * action_dim
    action_dim: int
    chunk_size: int
    stats: dict[str, Any] | None = None


# ---- base64 <-> ndarray codecs ---------------------------------------------


def _b64_of(arr: Any) -> str:
    """Base64 of the array's raw little-endian bytes -- the JS side encodes
    the typed array's underlying buffer the same way."""
    return base64.b64encode(arr.tobytes()).decode("ascii")


def _f32_from_b64(b64: str) -> Any:
    numpy = _require_numpy()
    return numpy.frombuffer(base64.b64decode(b64), dtype="<f4")


def _as_typed(value: Any, dtype: str) -> Any:
    """Coerce a caller-supplied array-like into the exact wire dtype, without
    copying when it already matches (same contract as passing Float32Array /
    Int32Array / Uint8Array in JS)."""
    numpy = _require_numpy()
    return numpy.ascontiguousarray(numpy.asarray(value, dtype=numpy.dtype(dtype)))


# ---- Preprocessing helpers (verbatim ports of vla-helpers.ts) --------------


def _detect_scale(pixels: Any) -> float:
    numpy = _require_numpy()
    if pixels.dtype == numpy.uint8:
        return 1 / 255
    # Float arrays: scan a small window to decide [0,255] vs [0,1].
    limit = min(pixels.size, 256)
    max_val = float(pixels.reshape(-1)[:limit].max()) if limit else 0.0
    return 1 / 255 if max_val > 1.001 else 1


def vla_preprocess_image(
    pixels: Any,
    width: int,
    height: int,
    *,
    size: int = VLA_DEFAULT_IMAGE_SIZE,
    layout: str = "hwc",
    scale: float | str = "auto",
) -> Any:
    """Resize + letterbox + normalize a camera frame to `(3, size, size)`
    float32 in `[-1, 1]`, flattened CHW -- drop-in equivalent of
    `@qvac/vla-ggml`'s `preprocessImage` (and the SDK's `vlaPreprocessImage`).

    Letterbox places the resized content at the bottom-right with padding at
    top/left, matching the reference smolvla.cpp behavior. Bilinear weights
    are computed in float64 and stored as float32, byte-matching the JS
    implementation."""
    numpy = _require_numpy()
    if layout not in ("hwc", "chw"):
        raise TypeError("vla_preprocess_image: layout must be 'hwc' or 'chw'")
    if (
        not isinstance(width, int)
        or not isinstance(height, int)
        or width <= 0
        or height <= 0
    ):
        raise TypeError("vla_preprocess_image: width/height must be positive integers")

    src = numpy.asarray(pixels)
    expected = width * height * 3
    if src.size != expected:
        raise ValueError(
            f"vla_preprocess_image: expected {expected} pixel values, got {src.size}"
        )

    normalize = (
        float(scale)
        if isinstance(scale, (int, float)) and scale in (1, 1 / 255)
        else _detect_scale(src)
    )

    # Letterbox target size (aspect-ratio preserving).
    ratio = max(width / size, height / size)
    new_w = max(1, int(width / ratio))
    new_h = max(1, int(height / ratio))
    pad_left = size - new_w
    pad_top = size - new_h
    x_scale = width / new_w
    y_scale = height / new_h

    # Reshape the source to (height, width, 3) regardless of input layout.
    values = src.astype(numpy.float64, copy=False)
    if layout == "hwc":
        plane = values.reshape(height, width, 3)
    else:
        plane = values.reshape(3, height, width).transpose(1, 2, 0)

    # Bilinear sample positions (center-aligned), identical formulas to JS.
    yy = numpy.arange(new_h, dtype=numpy.float64)
    xx = numpy.arange(new_w, dtype=numpy.float64)
    y_in = (yy + 0.5) * y_scale - 0.5
    x_in = (xx + 0.5) * x_scale - 0.5
    y0 = numpy.maximum(0, numpy.floor(y_in)).astype(numpy.int64)
    x0 = numpy.maximum(0, numpy.floor(x_in)).astype(numpy.int64)
    y1 = numpy.minimum(height - 1, y0 + 1)
    x1 = numpy.minimum(width - 1, x0 + 1)
    dy = numpy.clip(y_in - y0, 0, 1)[:, None]  # (new_h, 1)
    dx = numpy.clip(x_in - x0, 0, 1)[None, :]  # (1, new_w)

    w00 = (1 - dx) * (1 - dy)
    w10 = dx * (1 - dy)
    w01 = (1 - dx) * dy
    w11 = dx * dy

    # Gather the four corners for all channels at once: (new_h, new_w, 3).
    p00 = plane[y0[:, None], x0[None, :]]
    p10 = plane[y0[:, None], x1[None, :]]
    p01 = plane[y1[:, None], x0[None, :]]
    p11 = plane[y1[:, None], x1[None, :]]

    blended = (
        p00 * w00[..., None]
        + p10 * w10[..., None]
        + p01 * w01[..., None]
        + p11 * w11[..., None]
    )
    normalized = blended * normalize * 2 - 1  # float64, like JS pre-store math

    out = numpy.full((3, size, size), -1.0, dtype=numpy.float32)
    out[:, pad_top:, pad_left:] = normalized.transpose(2, 0, 1).astype(numpy.float32)
    return out.reshape(-1)


def vla_pad_state(state: Any, target_dim: int = 32) -> Any:
    """Zero-pad a state vector to `target_dim` float32 entries; input longer
    than `target_dim` raises. Mirrors `vlaPadState`."""
    numpy = _require_numpy()
    if not isinstance(target_dim, int) or target_dim <= 0:
        raise TypeError("vla_pad_state: target_dim must be a positive integer")
    src = numpy.asarray(state, dtype=numpy.float32).reshape(-1)
    if src.size > target_dim:
        raise ValueError(
            f"vla_pad_state: input length {src.size} exceeds target_dim {target_dim}"
        )
    out = numpy.zeros(target_dim, dtype=numpy.float32)
    out[: src.size] = src
    return out


# ---- Plugin-handler calls ----------------------------------------------------


async def vla(
    transport: Transport,
    *,
    model_id: str,
    images: list[Any],
    img_width: int,
    img_height: int,
    state: Any,
    tokens: Any,
    mask: Any,
    noise: Any = None,
) -> VlaRunResult:
    """Run VLA inference on a loaded model (SmolVLA or pi-0.5) and return the
    produced action chunk plus per-stage timings. Mirrors JS's `vla()`:
    float32 images/state/noise, int32 tokens, uint8 mask are base64-encoded
    onto the `vlaRun` plugin request; the response's `actions` decode back to
    a float32 array of length `chunk_size * action_dim`."""

    def _marshal() -> dict[str, Any]:
        wire_request: dict[str, Any] = {
            "type": "vlaRun",
            "modelId": model_id,
            "images": [_b64_of(_as_typed(img, "<f4")) for img in images],
            "imgWidth": img_width,
            "imgHeight": img_height,
            "state": _b64_of(_as_typed(state, "<f4")),
            "tokens": _b64_of(_as_typed(tokens, "<i4")),
            "mask": _b64_of(_as_typed(mask, "u1")),
        }
        if noise is not None:
            wire_request["noise"] = _b64_of(_as_typed(noise, "<f4"))
        return wire_request

    # Copy/contiguous/tobytes/base64 over several camera frames is CPU-heavy;
    # run it in a thread so a fast VLA control loop doesn't stall the event
    # loop (and everything else on it) on every call.
    wire_request = await asyncio.to_thread(_marshal)

    result = await invoke_plugin(
        transport, model_id, _VLA_RUN_HANDLER, params=wire_request
    )
    parsed = _VlaRunResponse.model_validate(result)
    actions = await asyncio.to_thread(_f32_from_b64, parsed.actions)
    return VlaRunResult(
        actions=actions,
        action_dim=parsed.action_dim,
        chunk_size=parsed.chunk_size,
        stats=parsed.stats,
    )


async def vla_hparams(
    transport: Transport, *, model_id: str
) -> tuple[VlaHparams, str | None]:
    """Fetch the loaded VLA model's hyperparameters and the active ggml
    backend name -- sizes token/state/noise buffers before calling `vla()`."""
    wire_request = {"type": "vlaHparams", "modelId": model_id}
    result = await invoke_plugin(
        transport, model_id, _VLA_HPARAMS_HANDLER, params=wire_request
    )
    parsed = _VlaHparamsResponse.model_validate(result)
    return parsed.hparams, parsed.backend_name


__all__ = [
    "NUMPY_AVAILABLE",
    "NumpyNotInstalledError",
    "VLA_DEFAULT_IMAGE_SIZE",
    "VlaHparams",
    "VlaRunResult",
    "vla",
    "vla_hparams",
    "vla_pad_state",
    "vla_preprocess_image",
]
