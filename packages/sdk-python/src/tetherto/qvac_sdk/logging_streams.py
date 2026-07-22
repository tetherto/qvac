"""Client logging parity: per-model log fan-in and the all-logs firehose.

Ports the JS SDK's `client/logging-stream-registry.ts`,
`client/api/logging-stream.ts`, and `client/api/subscribe-logs.ts`. Worker
logs arrive over the `loggingStream` server-stream; this module pumps them in
background asyncio tasks and dispatches to a caller-supplied logger --
anything with `error/warning/info/debug` methods, i.e. a stdlib
`logging.Logger` works directly (the JS `warn` level maps to `warning`).

The registry is module-global keyed by model id, same as the JS client's
`activeStreams` map.
"""

from __future__ import annotations

import asyncio
import logging as _stdlib_logging
from collections.abc import AsyncIterator, Callable
from typing import Any

from ._generated import methods as _methods
from ._transport import Transport
from .schemas import LoggingStreamRequest, LoggingStreamResponse

# Reserved stream ids (logging/namespaces.ts): the SDK server's own logs, and
# the fan-in stream the worker routes every log into.
SDK_LOG_ID = "__sdk__"
SDK_ALL_LOG_ID = "__all__"

_logger = _stdlib_logging.getLogger("qvac")

_active_streams: dict[str, asyncio.Task[None]] = {}


def logging_stream(
    transport: Transport, id: str
) -> AsyncIterator[LoggingStreamResponse]:
    """Open a logging stream for `id` -- a model id, `SDK_LOG_ID` for SDK
    server logs, or `SDK_ALL_LOG_ID` for every log. Mirrors JS's
    `loggingStream()`."""
    request = LoggingStreamRequest.model_validate({"type": "loggingStream", "id": id})
    return _methods.logging_stream(transport, request)


def _dispatch(log: LoggingStreamResponse, target: Any) -> None:
    prefix = f"[{log.namespace}]"
    level = log.level.value
    if level == "error":
        target.error("%s %s", prefix, log.message)
    elif level == "warn":
        target.warning("%s %s", prefix, log.message)
    elif level == "debug":
        target.debug("%s %s", prefix, log.message)
    else:  # info and anything unrecognized, matching the JS default arm
        target.info("%s %s", prefix, log.message)


def start_logging_stream_for_model(
    transport: Transport, model_id: str, model_logger: Any
) -> None:
    """Start pumping the model's worker logs into `model_logger` in a
    background task. A second start for the same model id warns and no-ops,
    matching JS."""
    if model_id in _active_streams:
        _logger.warning("Logging stream already active for model %s", model_id)
        return

    async def pump() -> None:
        try:
            async for log in logging_stream(transport, model_id):
                _dispatch(log, model_logger)
        except asyncio.CancelledError:
            raise
        except Exception:
            _logger.exception("Logging stream error for model %s", model_id)
        finally:
            _active_streams.pop(model_id, None)

    _active_streams[model_id] = asyncio.get_running_loop().create_task(pump())


def stop_logging_stream_for_model(model_id: str) -> None:
    """Stop the model's log pump; closing the iterator ends the server-side
    generator, same as JS's `streamIterator.return()`."""
    task = _active_streams.pop(model_id, None)
    if task is not None:
        task.cancel()
        _logger.debug("Stopped logging stream for model %s", model_id)


def has_active_stream_for_model(model_id: str) -> bool:
    return model_id in _active_streams


def subscribe_server_logs(
    transport: Transport, handler: Callable[[LoggingStreamResponse], None]
) -> Callable[[], None]:
    """Subscribe to every server-side log through the reserved
    `SDK_ALL_LOG_ID` fan-in stream: SDK server logs, per-model addon logs for
    all loaded models, RAG logs. Each log keeps its origin in `log.id`.
    Returns an unsubscribe function. Mirrors JS's `subscribeServerLogs()`."""

    async def pump() -> None:
        try:
            async for log in logging_stream(transport, SDK_ALL_LOG_ID):
                handler(log)
        except asyncio.CancelledError:
            raise
        except Exception:
            _logger.exception("Server log stream error")

    task = asyncio.get_running_loop().create_task(pump())

    def unsubscribe() -> None:
        task.cancel()

    return unsubscribe


__all__ = [
    "SDK_LOG_ID",
    "SDK_ALL_LOG_ID",
    "logging_stream",
    "start_logging_stream_for_model",
    "stop_logging_stream_for_model",
    "has_active_stream_for_model",
    "subscribe_server_logs",
]
