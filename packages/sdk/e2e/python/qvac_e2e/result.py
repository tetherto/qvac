"""The four states a test can land in, from the client's side.

`skipped` is a statement about the platform and is decided by the framework
from catalog data, so a client never produces it. A client produces `pass`,
`fail`, or `incomplete` -- the last meaning the test applies here but this
client has not implemented what it needs yet. Keeping `incomplete` distinct
from `fail` is what stops a thin client from looking green by not claiming
much.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class _NotAsserted:
    """No assertion ran, as distinct from an assertion whose value was null.

    A plain None cannot tell those apart, and collapsing them drops this client
    out of the cross-client value comparison for any test asserting on null.
    """

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<not asserted>"


_NOT_ASSERTED = _NotAsserted()


@dataclass
class StepResult:
    passed: bool
    output: str = ""
    is_incomplete: bool = False
    reason: str | None = None
    # The value the assertion ran against. Captured from the first migrated
    # category onward so cross-client comparison has a baseline well before a
    # second client is green.
    asserted_value: Any = field(default=_NOT_ASSERTED)

    @staticmethod
    def ok(output: str = "", asserted_value: Any = _NOT_ASSERTED) -> StepResult:
        return StepResult(passed=True, output=output, asserted_value=asserted_value)

    @staticmethod
    def fail(output: str, asserted_value: Any = _NOT_ASSERTED) -> StepResult:
        return StepResult(passed=False, output=output, asserted_value=asserted_value)

    @staticmethod
    def incomplete(reason: str) -> StepResult:
        return StepResult(
            passed=False, output=reason, is_incomplete=True, reason=reason
        )

    def to_message(self) -> dict[str, Any]:
        message: dict[str, Any] = {
            "type": "result",
            "passed": self.passed,
            "output": self.output,
        }
        if self.is_incomplete:
            message["incomplete"] = True
            message["reason"] = self.reason
        if self.asserted_value is not _NOT_ASSERTED:
            # Emitted whenever an assertion ran, even when the value itself is
            # null. JS always attaches it, and dropping it here would quietly
            # remove this client from the cross-client value comparison for
            # exactly the tests whose result is null.
            message["assertedValue"] = _summarise(self.asserted_value)
        return message


def _summarise(value: Any, depth: int = 0, limit: int = 64) -> Any:
    """Keep the report small while still comparable across clients.

    A full embedding vector is thousands of floats; what a cross-client diff
    needs is the shape and a stable sample, not the whole payload.

    `depth` stops at the same place the JS summariser stops. Without it the two
    clients describe a deeply nested value differently -- one expanded, one
    elided -- and the comparison reports drift in its own reporting.
    """
    if depth > 3:
        return "…"
    if isinstance(value, (list, tuple)):
        return {
            "kind": "array",
            "length": len(value),
            "head": [_summarise(v, depth + 1, limit) for v in value[:8]],
        }
    if isinstance(value, (bytes, bytearray, memoryview)):
        # Without this a PCM buffer or an image falls through to str(), which
        # renders the whole payload as an escaped repr -- the opposite of what
        # this function is for, and a multi-megabyte line for the bridge to
        # buffer. Hex head, matching what the JS summariser reports.
        raw = bytes(value)
        return {"kind": "bytes", "length": len(raw), "head": raw[:8].hex()}
    if isinstance(value, str):
        return value if len(value) <= limit * 8 else value[: limit * 8] + "…"
    if isinstance(value, dict):
        return {k: _summarise(v, depth + 1, limit) for k, v in list(value.items())[:16]}
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    # Anything else (an enum, a date, a model object) would take the bridge
    # down on serialisation. A report is never worth crashing a run over.
    return str(value)


def js_string(value: Any) -> str:
    """Render a value the way JavaScript's `String()` does.

    Wherever the catalog turns a value into text -- `project`'s `join`, the
    field comparisons -- the two clients have to spell it identically, or a
    step that agrees on the value reports drift on the spelling. Python's
    `str()` disagrees with `String()` on exactly the things that cross this
    wire: `True`/`true`, `None`/`null`, and `4.0`/`4` for a whole number that
    arrived as a JSON number.
    """
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (list, tuple)):
        return ",".join(js_string(item) for item in value)
    return str(value)
