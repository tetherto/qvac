"""Bridge client: reads one test at a time from stdin, answers on stdout.

The framework keeps the MQTT state machine -- registration, the queue,
heartbeats, per-test timeouts, retry and reload, profiling -- so this process
only has to interpret a definition and report a verdict. That is the whole
point: a new client is an interpreter, not a port of the test suite.

Protocol (newline-delimited JSON, one request in flight):

    -> {"type": "ready", "protocol": 1}
    <- {"type": "execute", "testId", "params", "expectation", "metadata", "steps"}
    -> {"type": "log", "message": "..."}            (zero or more)
    -> {"type": "result", "passed", "output", ...}
    <- {"type": "shutdown"}

stdout is protocol only; anything diagnostic goes to stderr, which the
framework forwards into the run log.

RUN: python -m qvac_e2e.runner   (driven by the framework, not by hand)
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from tetherto.qvac_sdk import Client

from .imperative import IMPERATIVE
from .interpreter import Interpreter
from .resources import ResourceManager
from .result import StepResult

PROTOCOL_VERSION = 1


def _write(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    _write({"type": "log", "message": message})


async def _read_line(reader: asyncio.StreamReader) -> str | None:
    line = await reader.readline()
    if not line:
        return None
    return line.decode("utf-8").strip()


async def _stdin_reader() -> asyncio.StreamReader:
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin)
    return reader


async def main() -> int:
    reader = await _stdin_reader()

    # The worker is resolved from QVAC_WORKER_PATH so this client and the JS
    # legs drive the same binary. Without that the comparison is meaningless:
    # a difference could just as well be a different engine build.
    async with Client() as client:
        resources = ResourceManager(client.transport, _log)
        interpreter = Interpreter(resources, _log)

        _write({"type": "ready", "protocol": PROTOCOL_VERSION})

        try:
            while True:
                line = await _read_line(reader)
                if line is None:
                    break
                if not line:
                    continue

                try:
                    request = json.loads(line)
                except json.JSONDecodeError as error:
                    _log(f"ignoring malformed request: {error}")
                    continue

                kind = request.get("type")
                if kind == "shutdown":
                    break
                if kind != "execute":
                    _log(f"ignoring unknown request type: {kind!r}")
                    continue

                result = await _execute(interpreter, resources, request)
                _write(result.to_message())
        finally:
            await resources.close()

    return 0


async def _execute(
    interpreter: Interpreter, resources: ResourceManager, request: dict[str, Any]
) -> StepResult:
    test_id = request.get("testId", "<unknown>")
    steps = request.get("steps") or []
    if not steps:
        # No declarative body, so this client answers with its own if it has
        # one. Some tests cannot be data -- several calls in flight at once, a
        # cancellation racing a read -- and those are written per client.
        body = IMPERATIVE.get(test_id)
        if body is None:
            return StepResult.incomplete(
                f"{test_id} carries no steps and this client has no body for it"
            )
        try:
            return await body(
                resources,
                request.get("params") or {},
                request.get("expectation") or {},
            )
        except Exception as error:  # noqa: BLE001 - never take the bridge down
            return StepResult.fail(f"{type(error).__name__}: {error}")

    try:
        return await interpreter.run(
            steps=steps,
            params=request.get("params") or {},
            expectation=request.get("expectation") or {},
            teardown=request.get("finally") or [],
        )
    except Exception as error:  # noqa: BLE001 - never take the bridge down
        return StepResult.fail(f"{type(error).__name__}: {error}")


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
