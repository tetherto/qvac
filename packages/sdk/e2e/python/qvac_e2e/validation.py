"""Port of the framework's ValidationHelpers.

The expectation is shared data, so the two clients must agree on what it
means. Every branch here mirrors `packages/test-suite/src/utils/validation-
helpers.ts` exactly -- including the lowercasing in the `contains` checks and
the 200-character truncation in failure output -- so that a disagreement
between the clients is a real disagreement about the result, not about how the
expectation was read.

`validation: "function"` is deliberately unsupported: a JavaScript closure
cannot cross the wire. Definitions that still use it are reported as
incomplete rather than failed.
"""

from __future__ import annotations

import re
from typing import Any

from .result import StepResult


def _as_text(value: Any) -> str:
    """Mirror JavaScript's String(value) closely enough for these checks."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return ",".join(_as_text(v) for v in value)
    return str(value)


def _js_type(value: Any) -> str:
    if isinstance(value, (list, tuple)):
        return "array"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if value is None:
        return "object"
    return "object"


def validate(result: Any, expectation: dict[str, Any]) -> StepResult:
    kind = expectation.get("validation")
    try:
        if kind == "contains-all":
            return _contains_all(result, expectation.get("contains", []))
        if kind == "contains-any":
            return _contains_any(result, expectation.get("contains", []))
        if kind == "regex":
            return _regex(result, expectation["pattern"])
        if kind == "numeric-range":
            return _numeric_range(
                result, expectation.get("min"), expectation.get("max")
            )
        if kind == "type":
            return _type(
                result, expectation["expectedType"], expectation.get("minLength")
            )
        if kind == "throws-error":
            return _throws_error(result, expectation["errorContains"])
        if kind == "function":
            return StepResult.incomplete(
                "expectation uses validation: 'function'; a JS closure cannot cross the "
                "wire. Migrate it to a named assertion."
            )
        return StepResult.fail(f"Unknown validation type: {kind}")
    except Exception as error:  # noqa: BLE001 - mirrors the JS catch-all
        return StepResult.fail(f"Validation error: {error}")


def _contains_all(result: Any, contains: list[str]) -> StepResult:
    text = _as_text(result).lower()
    missing = [s for s in contains if s.lower() not in text]
    if not missing:
        return StepResult.ok(text)
    return StepResult.fail(
        f"Missing required strings: {', '.join(missing)}. Got: {text[:200]}"
    )


def _contains_any(result: Any, contains: list[str]) -> StepResult:
    text = _as_text(result).lower()
    if any(s.lower() in text for s in contains):
        return StepResult.ok(text)
    return StepResult.fail(
        f"None of the required strings found: {', '.join(contains)}. Got: {text[:200]}"
    )


def _regex(result: Any, pattern: str) -> StepResult:
    text = _as_text(result)
    if re.search(pattern, text):
        return StepResult.ok(text)
    return StepResult.fail(f"Text does not match pattern {pattern}. Got: {text[:200]}")


def _numeric_range(
    result: Any, minimum: float | None, maximum: float | None
) -> StepResult:
    try:
        num = float(result) if not isinstance(result, bool) else float("nan")
    except (TypeError, ValueError):
        return StepResult.fail(f"Expected number, got: {_as_text(result)}")
    if num != num:  # NaN
        return StepResult.fail(f"Expected number, got: {_as_text(result)}")
    if minimum is not None and num < minimum:
        return StepResult.fail(f"Value {_num(num)} is below minimum {_num(minimum)}")
    if maximum is not None and num > maximum:
        return StepResult.fail(f"Value {_num(num)} is above maximum {_num(maximum)}")
    return StepResult.ok(_num(num))


def _num(value: float) -> str:
    """Format like JS String(number): integers without a trailing .0."""
    return str(int(value)) if float(value).is_integer() else str(value)


def _type(result: Any, expected_type: str, min_length: int | None) -> StepResult:
    actual = _js_type(result)
    if actual != expected_type:
        return StepResult.fail(f"Expected {expected_type}, got {actual}")
    if expected_type == "array" and min_length and len(result) < min_length:
        return StepResult.fail(
            f"Array has {len(result)} elements, expected at least {min_length}"
        )
    if expected_type == "array":
        return StepResult.ok(f"Array with {len(result)} elements")
    return StepResult.ok(f"Type {actual} matches")


def _throws_error(result: Any, error_contains: str) -> StepResult:
    text = _as_text(result).lower()
    if error_contains.lower() in text:
        return StepResult.ok(f"Error contains expected text: {error_contains}")
    return StepResult.fail(
        f'Error does not contain "{error_contains}". Got: {_as_text(result)[:200]}'
    )
