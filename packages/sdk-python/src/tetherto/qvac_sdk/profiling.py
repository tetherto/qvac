"""Per-call profiling parity over the `__profiling` wire envelope.

Ports the JS SDK's `profiling/envelope.ts` + the per-call slice of
`client/rpc/rpc-client.ts`'s profiled send path: the request carries
`__profiling: {enabled, id, includeServer}`, and the worker (when asked)
attaches `__profiling: {id, server?, delegation?, operation?}` to its reply.
`profiled_call()` wraps one unary call, measuring the client-side wall time
and surfacing the server's breakdown; the envelope helpers are exported for
callers composing their own instrumented flows.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Any

from ._transport import Transport

PROFILING_KEY = "__profiling"


def create_profiling_meta(
    profile_id: str, include_server_breakdown: bool
) -> dict[str, Any]:
    return {
        "enabled": True,
        "id": profile_id,
        "includeServer": include_server_breakdown,
    }


def create_profiling_disabled_meta() -> dict[str, Any]:
    return {"enabled": False}


def inject_profiling_meta(
    payload: dict[str, Any], meta: dict[str, Any]
) -> dict[str, Any]:
    return {**payload, PROFILING_KEY: meta}


def extract_profiling_meta(payload: Any) -> dict[str, Any] | None:
    if isinstance(payload, dict):
        meta = payload.get(PROFILING_KEY)
        if isinstance(meta, dict):
            return meta
    return None


def strip_profiling_meta(payload: dict[str, Any]) -> dict[str, Any]:
    if PROFILING_KEY in payload:
        return {k: v for k, v in payload.items() if k != PROFILING_KEY}
    return payload


@dataclass(frozen=True)
class ProfilingReport:
    profile_id: str
    request_type: str
    total_ms: float
    server: dict[str, Any] | None = None
    delegation: dict[str, Any] | None = None
    operation: dict[str, Any] | None = None


async def profiled_call(
    transport: Transport,
    payload: dict[str, Any],
    *,
    include_server_breakdown: bool = True,
) -> tuple[dict[str, Any], ProfilingReport]:
    """One profiled unary call: inject the `__profiling` request meta, time
    the round trip client-side, and split the worker's breakdown out of the
    reply. Returns `(response_without_meta, report)`."""
    profile_id = str(uuid.uuid4())
    meta = create_profiling_meta(profile_id, include_server_breakdown)

    start = time.perf_counter()
    response = await transport.call(inject_profiling_meta(payload, meta))
    total_ms = (time.perf_counter() - start) * 1000

    response_meta = extract_profiling_meta(response) or {}
    report = ProfilingReport(
        profile_id=profile_id,
        request_type=str(payload.get("type", "")),
        total_ms=total_ms,
        server=response_meta.get("server"),
        delegation=response_meta.get("delegation"),
        operation=response_meta.get("operation"),
    )
    return strip_profiling_meta(response), report


__all__ = [
    "PROFILING_KEY",
    "ProfilingReport",
    "create_profiling_meta",
    "create_profiling_disabled_meta",
    "inject_profiling_meta",
    "extract_profiling_meta",
    "strip_profiling_meta",
    "profiled_call",
]
