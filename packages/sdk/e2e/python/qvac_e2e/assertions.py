"""Named assertions: the checks that are more than "contains this string".

These replace the JavaScript-function expectations in the catalog, which
cannot cross the wire. Each one is written once per client, against a name
that is part of the shared vocabulary — so two clients checking
`loadedModelInfoShape` are checking the same thing, not each their own idea
of it.

`args` carries the step's `with` block, already reference-resolved. That is
what lets a check compare the result against something the test set up rather
than only against a constant.
"""

from __future__ import annotations

import re

from collections.abc import Callable
from typing import Any

import json

from .result import StepResult, js_string


def _is_integer(value: Any) -> bool:
    """JS's `Number.isInteger`, not Python's `isinstance(x, int)`.

    The two disagree on exactly the values that cross the wire here. A JSON
    `0` stays the number 0 in JS, while the generated Pydantic models type
    several of these fields as `float`, so Python sees `0.0` -- an integer
    value that is not an `int` instance. Asserting membership of `int` would
    fail the Python client for a difference that only exists in how each
    client's own deserializer spells a whole number.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()


def length_is(value: Any, args: dict[str, Any]) -> StepResult:
    """The collection has exactly the expected number of elements.

    Deliberately generic: `topK: 1 must truncate to one result` is the same
    check as "this many blocks came back", and a registry of one-off names
    would defeat the point of a shared vocabulary.
    """
    if not isinstance(value, list):
        return StepResult.fail(f"expected an array, got {type(value).__name__}")
    expected = int(args.get("length", -1))
    if len(value) != expected:
        return StepResult.fail(f"expected {expected} element(s), got {len(value)}")
    return StepResult.ok(f"{len(value)} element(s)")


def length_at_least(value: Any, args: dict[str, Any]) -> StepResult:
    """The collection has at least this many elements.

    The floor half of `length_is`: "the registry lists models" and "more than
    one result came back" are the same check with a different bound, and a test
    that pinned the exact count would fail whenever the registry grew.
    """
    if not isinstance(value, list):
        return StepResult.fail(f"expected an array, got {type(value).__name__}")
    minimum = int(args.get("length", 0))
    if len(value) < minimum:
        return StepResult.fail(f"expected at least {minimum}, got {len(value)}")
    return StepResult.ok(f"{len(value)} element(s)")


def numbers_in_range(value: Any, args: dict[str, Any]) -> StepResult:
    """Named numbers sit inside the range.

    A probability is in [0,1] and a utilisation is in [0,1]; naming the bound
    in the test rather than the registry keeps one check answering both.

    The value is a list of records, one record, or a bare number: an
    embodiment's category id is a single number with a bound, and wrapping it
    in a list to satisfy the assertion would be the test bending to the check.
    `field` is what to read off a record and is not needed for a bare number;
    `integer` additionally requires a whole number, which a category id is and
    a probability is not.
    """
    field = args.get("field")
    low, high = float(args.get("min", 0)), float(args.get("max", 1))
    integer = args.get("integer") is True
    items = value if isinstance(value, list) else [value]
    for item in items:
        if field is None:
            measured = item
        else:
            measured = item.get(str(field)) if isinstance(item, dict) else None
        label = str(field) if field is not None else "value"
        if (
            not isinstance(measured, (int, float))
            or isinstance(measured, bool)
            or not low <= measured <= high
        ):
            return StepResult.fail(f"{label} is outside [{low}, {high}]: {measured!r}")
        if integer and not _is_integer(measured):
            return StepResult.fail(f"{label} is not an integer: {measured}")
    return StepResult.ok(f"{len(items)} value(s) within [{low}, {high}]")


def equals_joined(value: Any, args: dict[str, Any]) -> StepResult:
    """The text is exactly the parts joined by the separator.

    A batch translation returns both the entries and one text, and the claim is
    that they are the same answer in two shapes rather than two answers.
    """
    parts = [str(part) for part in (args.get("parts") or [])]
    expected = str(args.get("separator", "\n")).join(parts)
    if value != expected:
        return StepResult.fail(f"expected {expected!r}, got {value!r}")
    return StepResult.ok(f"{len(parts)} part(s) joined")


def _frame_dimensions(data: bytes) -> tuple[int, int] | None:
    """PNG IHDR or JPEG SOF0 dimensions, so both frame encodings are accepted.

    The world session emits whichever its encoder produced, and a test about
    the picture should not care which.
    """
    png = _png_dimensions(data)
    if png is not None:
        return png
    if len(data) < 24 or data[0] != 0xFF or data[1] != 0xD8:
        return None
    offset = 2
    while offset + 9 < len(data):
        if data[offset] != 0xFF:
            return None
        marker = data[offset + 1]
        length = int.from_bytes(data[offset + 2 : offset + 4], "big")
        # SOF0..SOF3 -- baseline, extended, progressive and lossless. Excludes
        # 0xC4 (DHT), which shares the 0xCn range but is not a frame header.
        if 0xC0 <= marker <= 0xC3:
            height = int.from_bytes(data[offset + 5 : offset + 7], "big")
            width = int.from_bytes(data[offset + 7 : offset + 9], "big")
            return width, height
        offset += 2 + length
    return None


def frames_are(value: Any, args: dict[str, Any]) -> StepResult:
    """A block of frames: this many, each at this size.

    Both encodings are read, because which one the engine emits is its business
    and the claim is about the picture. The count matters as much as the size:
    the first block after a load is shorter than the ones after it, so a body
    that only checked dimensions could not tell a fresh session from a
    continuing one.
    """
    frames = value if isinstance(value, list) else []
    expected = int(args.get("count", 0))
    if len(frames) != expected:
        return StepResult.fail(f"expected {expected} frame(s), got {len(frames)}")
    width, height = int(args.get("width", 0)), int(args.get("height", 0))
    for index, frame in enumerate(frames):
        dims = _frame_dimensions(_as_bytes(frame))
        if dims is None:
            return StepResult.fail(f"frame {index} is undecodable")
        if dims != (width, height):
            return StepResult.fail(
                f"frame {index} is {dims[0]}x{dims[1]}, expected {width}x{height}"
            )
    return StepResult.ok(f"{expected} frame(s) at {width}x{height}")


def safetensors_container(value: Any, args: dict[str, Any]) -> StepResult:
    """The bytes are a safetensors container.

    A cheap structural read of the header, which is what tells a real pack from
    an error page or a truncated write -- both of which are non-empty byte
    arrays and would satisfy a length check.
    """
    data = _as_bytes(value)
    floor = int(args.get("minBytes", 1024))
    if len(data) < floor:
        return StepResult.fail(f"pack is {len(data)} bytes, expected at least {floor}")
    header_length = int.from_bytes(data[0:8], "little")
    # A little-endian u64 header length, then that many bytes of JSON starting
    # with '{'.
    if header_length <= 0 or header_length + 8 > len(data) or data[8] != 0x7B:
        return StepResult.fail(
            f"not a safetensors container (header length {header_length})"
        )
    return StepResult.ok(f"{len(data)} bytes, header {header_length}")


def no_progress_batch_gaps(value: Any, _args: dict[str, Any]) -> StepResult:
    """Every batch of every phase reported its progress, with no gaps.

    A training run emits one update per batch per phase; the engine tells you
    how many batches a phase has, so a phase that reported fewer unique batches
    than it declared dropped some. Counting events alone would not catch it --
    the total can look healthy while one epoch is missing three batches in the
    middle.
    """
    events = value if isinstance(value, list) else []
    if not events:
        return StepResult.fail("no progress events received")

    phases: dict[str, dict[str, Any]] = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        key = ("train" if event.get("is_train") else "val") + (
            f":epoch{event.get('current_epoch')}"
        )
        total = int(event.get("total_batches") or 0)
        phase = phases.setdefault(key, {"batches": set(), "total": total})
        phase["batches"].add(event.get("current_batch"))
        if total > phase["total"]:
            phase["total"] = total

    drops = []
    for key, phase in phases.items():
        if len(phase["batches"]) < phase["total"]:
            received = sorted(b for b in phase["batches"] if b is not None)
            drops.append(
                f"{key}: {len(received)}/{phase['total']} "
                f"(received=[{','.join(str(b) for b in received)}])"
            )
    if drops:
        return StepResult.fail(f"progress events dropped: {'; '.join(drops)}")
    return StepResult.ok(
        f"{len(events)} event(s) across {len(phases)} phase(s), no batch gaps"
    )


def sorted_ascending_by(value: Any, args: dict[str, Any]) -> StepResult:
    """The list is ordered by the named field, smallest first.

    Log timestamps: entries arriving out of order would make every time-ordered
    read of a log stream wrong, without any single entry looking wrong.
    """
    items = value if isinstance(value, list) else []
    field = str(args.get("field"))
    minimum = int(args.get("minimum", 2))
    if len(items) < minimum:
        return StepResult.fail(f"need at least {minimum} element(s), got {len(items)}")
    for index in range(1, len(items)):
        current = (items[index] or {}).get(field) or 0
        previous = (items[index - 1] or {}).get(field) or 0
        if current < previous:
            return StepResult.fail(f"out of order by {field} at index {index}")
    return StepResult.ok(f"{len(items)} element(s) in order")


def any_element_positive(value: Any, args: dict[str, Any]) -> StepResult:
    """At least one element reports a finite, positive value for this field.

    Training loss: a run reports one per step, and some of them legitimately
    arrive as null or zero before the first backward pass. The claim is that
    the run produced a real number at some point -- a stream of nulls means the
    loss never reached the caller, however many updates arrived.
    """
    items = value if isinstance(value, list) else []
    field = str(args.get("field"))
    found = [
        item
        for item in items
        if isinstance(item, dict)
        and isinstance(item.get(field), (int, float))
        and not isinstance(item.get(field), bool)
        and item[field] > 0
    ]
    if not found:
        return StepResult.fail(
            f"no finite positive {field} across {len(items)} element(s)"
        )
    return StepResult.ok(f"{len(found)} of {len(items)} had a positive {field}")


def at_least(value: Any, args: dict[str, Any]) -> StepResult:
    """The number is at least this large.

    `cacheTokens` on a warm turn: any positive figure means the prefix was
    reused, and zero means it was not, whatever else the stats say.
    """
    minimum = float(args.get("value", 0))
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return StepResult.fail(f"expected a number, got {value!r}")
    if value < minimum:
        return StepResult.fail(f"expected at least {minimum:g}, got {value}")
    return StepResult.ok(str(value))


def is_absent(value: Any, _args: dict[str, Any]) -> StepResult:
    """Nothing is there.

    A completion that ran to its natural end reports no stop reason at all;
    `null` and `undefined` both mean that, and which one a client uses is a
    language detail rather than a difference in what happened.
    """
    if value is not None:
        return StepResult.fail(f"expected nothing, got {value!r}")
    return StepResult.ok("(absent)")


def below_budget(value: Any, args: dict[str, Any]) -> StepResult:
    """The value is a number strictly below the budget.

    The context-boundary test: stopping for "length" only proves the boundary
    if the run stopped before the prediction budget ran out, so the budget is
    the bound rather than the thing being measured.
    """
    budget = float(args.get("budget", 0))
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return StepResult.fail(f"expected a number, got {value!r}")
    if value >= budget:
        return StepResult.fail(
            f"expected fewer than the {budget:g} budgeted (boundary, not "
            f"prediction cutoff), got {value}"
        )
    return StepResult.ok(f"{value} of {budget:g}")


def at_least_field(value: Any, args: dict[str, Any]) -> StepResult:
    """One field of the record is at least as large as another.

    A context overflow reports the prompt it measured and the window it
    measured against; the guard trips on `>=`, so equality is legitimate and
    anything below means the parser read the wrong quantity.
    """
    record = value if isinstance(value, dict) else {}
    left_raw = record.get(str(args.get("field")))
    right_raw = record.get(str(args.get("atLeast")))
    if not isinstance(left_raw, (int, float)) or not isinstance(
        right_raw, (int, float)
    ):
        return StepResult.fail(
            f"expected numbers, got {args.get('field')}={left_raw!r} "
            f"{args.get('atLeast')}={right_raw!r}"
        )
    if left_raw < right_raw:
        return StepResult.fail(
            f"expected {args.get('field')} >= {args.get('atLeast')}, "
            f"got {left_raw} < {right_raw}"
        )
    return StepResult.ok(f"{left_raw} >= {right_raw}")


def json_object_shape(value: Any, args: dict[str, Any]) -> StepResult:
    """The text is a JSON object, with exactly these fields and types.

    `responseFormat` is a promise about the shape of the output, so the claim
    is structural: it parses, it is an object rather than an array or a scalar,
    each named field has the declared type, and -- when `exactKeys` is set --
    there is nothing else in it, which is what `additionalProperties: false`
    means.
    """
    text = str(value or "")
    try:
        parsed = json.loads(text)
    except ValueError as error:
        return StepResult.fail(f"not valid JSON: {error}. Output: {text[:200]}")
    if not isinstance(parsed, dict):
        kind = "array" if isinstance(parsed, list) else type(parsed).__name__
        return StepResult.fail(f"expected a JSON object, got {kind}")

    for field, kind in (args.get("fields") or {}).items():
        measured = parsed.get(field)
        if kind == "string" and (not isinstance(measured, str) or not measured):
            return StepResult.fail(
                f"{field} must be a non-empty string, got {measured!r}"
            )
        if kind == "integer" and not _is_integer(measured):
            return StepResult.fail(f"{field} must be an integer, got {measured!r}")
        if kind == "number" and (
            not isinstance(measured, (int, float)) or isinstance(measured, bool)
        ):
            return StepResult.fail(f"{field} must be a number, got {measured!r}")

    exact = args.get("exactKeys")
    if exact:
        actual = sorted(parsed)
        expected = sorted(exact)
        if actual != expected:
            return StepResult.fail(
                "additionalProperties:false violated. Expected exactly "
                f"[{','.join(expected)}], got [{','.join(actual)}]"
            )
    return StepResult.ok(f"object with keys [{','.join(parsed)}]")


def png_dimensions(value: Any, args: dict[str, Any]) -> StepResult:
    """The PNG has exactly these dimensions.

    What the per-test `validation: "function"` closures were checking. Those
    cannot cross to another client -- a function is not data -- so the numbers
    travel in `with` and the reading happens here.
    """
    raw = value[0] if isinstance(value, list) and value else value
    data = _as_bytes(raw)
    dims = _png_dimensions(data)
    if dims is None:
        return StepResult.fail(f"not a valid PNG ({len(data)} bytes)")
    width, height = int(args.get("width", 0)), int(args.get("height", 0))
    if dims != (width, height):
        return StepResult.fail(f"expected {width}x{height}, got {dims[0]}x{dims[1]}")
    return StepResult.ok(f"{dims[0]}x{dims[1]}")


def non_negative_numbers(value: Any, args: dict[str, Any]) -> StepResult:
    """These fields are numbers, and none of them is negative.

    The phase timings a run reports: zero is a legitimate reading for a phase
    that did no work, a negative one never is.
    """
    record = value if isinstance(value, dict) else {}
    fields = args.get("fields") or []
    for field in fields:
        measured = record.get(field)
        if (
            not isinstance(measured, (int, float))
            or isinstance(measured, bool)
            or measured < 0
        ):
            return StepResult.fail(
                f"{field} is not a non-negative number (got {measured!r})"
            )
    return StepResult.ok(f"{len(fields)} field(s) non-negative")


def fields_sum_to(value: Any, args: dict[str, Any]) -> StepResult:
    """The named fields add up to the total, within a tolerance.

    A diffusion run reports per-phase timings and one generation time; if they
    do not reconcile, one of the phases is not being accounted for. The
    tolerance is there because the total is integer-valued while the phases
    keep fractional milliseconds.
    """
    record = value if isinstance(value, dict) else {}
    fields = args.get("fields") or []
    total = sum(float(record.get(field) or 0) for field in fields)
    expected_raw = record.get(str(args.get("total")))
    if not isinstance(expected_raw, (int, float)) or isinstance(expected_raw, bool):
        return StepResult.fail(f"{args.get('total')} is missing from the record")
    expected = float(expected_raw)
    tolerance = max(
        float(args.get("minTolerance", 2)), expected * float(args.get("ratio", 0.01))
    )
    delta = abs(total - expected)
    if delta > tolerance:
        return StepResult.fail(
            f"phases sum to {total:.2f}, {args.get('total')}={expected}, "
            f"delta {delta:.2f}ms exceeds {tolerance:.2f}ms"
        )
    return StepResult.ok(f"phases reconcile within {delta:.2f}ms")


def no_partial_downloads(value: Any, _args: dict[str, Any]) -> StepResult:
    """The load was a cache hit: nothing was downloaded again.

    A real download reports many partial-percentage events per file; a cache
    hit reports at most a final one. Counting the partials is what makes "the
    cache held" observable from outside, since neither client can see the cache
    directory the way the engine does.
    """
    events = value if isinstance(value, list) else []
    partials = [
        event
        for event in events
        if isinstance(event, dict)
        and (event.get("total") or 0) > 0
        and (event.get("downloaded") or 0) < (event.get("total") or 0)
    ]
    if partials:
        keys = {str(event.get("downloadKey")) for event in partials}
        sample = ", ".join(
            f"{event.get('downloadKey')}@{float(event.get('percentage') or 0):.0f}%"
            for event in partials[:3]
        )
        return StepResult.fail(
            f"re-downloaded {len(keys)} file(s), {len(partials)} partial "
            f"event(s). First: {sample}"
        )
    return StepResult.ok(f"{len(events)} cache-hit notification(s)")


def transcript_segments_shape(value: Any, args: dict[str, Any]) -> StepResult:
    """Transcript segments are well formed and in audio-time order.

    Every field the consumer of a metadata transcription reads, plus the
    ordering invariant: segments are emitted in audio time, and ids only go
    forward. Out-of-order segments would reassemble into the wrong transcript
    without any single segment looking wrong.

    `flags` names extra boolean fields every segment must carry: parakeet adds
    `isEndOfTurn` / `startsWord`, whisper does not, and the difference is the
    whole point of the parakeet metadata test.
    """
    flags = args.get("flags") or []
    if not isinstance(value, list):
        return StepResult.fail(f"expected an array, got {type(value).__name__}")
    if not value:
        return StepResult.fail("expected at least one segment")

    previous_start = float("-inf")
    previous_id = float("-inf")
    for index, segment in enumerate(value):
        if not isinstance(segment, dict):
            return StepResult.fail(f"segment {index}: not an object")
        start_ms = segment.get("startMs")
        end_ms = segment.get("endMs")
        if not isinstance(segment.get("text"), str):
            return StepResult.fail(f"segment {index}: missing/invalid text")
        if not isinstance(start_ms, (int, float)) or isinstance(start_ms, bool):
            return StepResult.fail(f"segment {index}: missing/invalid startMs")
        if not isinstance(end_ms, (int, float)) or isinstance(end_ms, bool):
            return StepResult.fail(f"segment {index}: missing/invalid endMs")
        if end_ms < start_ms:
            return StepResult.fail(
                f"segment {index}: endMs {end_ms} < startMs {start_ms}"
            )
        if not isinstance(segment.get("append"), bool):
            return StepResult.fail(f"segment {index}: missing/invalid append")
        segment_id = segment.get("id")
        if not _is_integer(segment_id):
            return StepResult.fail(f"segment {index}: missing/invalid id")
        for flag in flags:
            if not isinstance(segment.get(flag), bool):
                return StepResult.fail(f"segment {index}: missing/invalid {flag}")
        if start_ms < previous_start:
            return StepResult.fail(
                f"segment {index}: out-of-order startMs {start_ms} < {previous_start}"
            )
        if segment_id < previous_id:
            return StepResult.fail(
                f"segment {index}: out-of-order id {segment_id} < {previous_id}"
            )
        previous_start = start_ms
        previous_id = segment_id
    carried = f", all carrying {' / '.join(flags)}" if flags else ""
    return StepResult.ok(f"{len(value)} segment(s) in order{carried}")


def event_type_counts(value: Any, args: dict[str, Any]) -> StepResult:
    """The event stream carries the types this test expects, not the forbidden.

    Counting by type is what all of these tests were doing by hand. `absent`
    matters as much as `atLeast`: parakeet must not emit standalone `vad`
    events, and a check that only looked for what it wanted would pass on a
    client that emitted everything.
    """
    events = value if isinstance(value, list) else []
    counts: dict[str, int] = {}
    for event in events:
        kind = str((event or {}).get("type", "unknown"))
        counts[kind] = counts.get(kind, 0) + 1
    summary = json.dumps(counts, sort_keys=True)

    for kind, minimum in (args.get("atLeast") or {}).items():
        if counts.get(kind, 0) < minimum:
            return StepResult.fail(
                f"expected at least {minimum} {kind} event(s), got {summary}"
            )
    for kind in args.get("absent") or []:
        if counts.get(kind):
            return StepResult.fail(
                f"{kind} event(s) were emitted but must not be: {summary}"
            )
    return StepResult.ok(summary)


def event_shape(value: Any, args: dict[str, Any]) -> StepResult:
    """Every event of this type carries the right fields and not the others.

    Parakeet's end-of-turn is token-driven and must declare
    `source: "parakeet"` without a `silenceDurationMs`; that field is the
    whisper variant, and a client that filled in both would be reporting a
    shape no consumer can discriminate on.
    """
    events = value if isinstance(value, list) else []
    kind = str(args.get("type"))
    equals = args.get("equals") or {}
    absent = args.get("absent") or []

    for event in events:
        if not isinstance(event, dict) or event.get("type") != kind:
            continue
        for field, expected in equals.items():
            if event.get(field) != expected:
                return StepResult.fail(
                    f"{kind} event has {field}={event.get(field)!r}, "
                    f"expected {expected!r}: {event}"
                )
        for field in absent:
            if event.get(field) is not None:
                return StepResult.fail(f"{kind} event must omit {field}: {event}")
    return StepResult.ok(f"{kind} events well formed")


def contains_all(value: Any, args: dict[str, Any]) -> StepResult:
    """The text contains every one of these terms.

    The same shape as a `contains-all` expectation, available as a named
    assertion so a body can ask it of something other than the one value the
    expectation is about -- a rejection's message alongside its code, say.
    """
    text = str(value or "").lower()
    terms = args.get("terms") or []
    missing = [term for term in terms if term.lower() not in text]
    if missing:
        return StepResult.fail(f"missing {missing} in: {str(value)[:200]}")
    return StepResult.ok(f"{len(terms)} term(s) present")


def contains_any(value: Any, args: dict[str, Any]) -> StepResult:
    """The text contains at least one of these terms."""
    text = str(value or "").lower()
    terms = args.get("terms") or []
    if not any(term.lower() in text for term in terms):
        return StepResult.fail(f"none of {terms} in: {str(value)[:200]}")
    return StepResult.ok("matched")


def any_field_present(value: Any, args: dict[str, Any]) -> StepResult:
    """At least one of the named fields is present.

    For the readings an engine may report in more than one shape: which timing
    field a backend fills is its business, that it reported timing at all is
    the claim.
    """
    record = value if isinstance(value, dict) else {}
    fields = args.get("fields") or []
    found = [field for field in fields if record.get(field) is not None]
    if not found:
        return StepResult.fail(f"none of {', '.join(fields)} are present")
    return StepResult.ok(f"{', '.join(found)} present")


def is_empty_text(value: Any, _args: dict[str, Any]) -> StepResult:
    """The value has no text in it.

    The empty-input tests: an empty prompt has nothing to translate, and the
    claim is that the client says so rather than inventing output.
    """
    if value is not None and not isinstance(value, str):
        return StepResult.fail(f"expected a string, got {type(value).__name__}")
    text = value or ""
    if text.strip():
        return StepResult.fail(f"expected no text, got: {text[:120]}")
    return StepResult.ok("(empty)")


def sorted_descending_by(value: Any, args: dict[str, Any]) -> StepResult:
    """The list is ordered by the named field, largest first."""
    items = value if isinstance(value, list) else []
    field = str(args.get("field"))

    def reading(item: Any) -> float:
        return float((item or {}).get(field) or 0)

    for index in range(1, len(items)):
        if reading(items[index]) > reading(items[index - 1]):
            return StepResult.fail(f"not sorted by {field} at index {index}")
    return StepResult.ok(f"{len(items)} element(s) in order")


def sums_to(value: Any, args: dict[str, Any]) -> StepResult:
    """The named field sums to a value, within a tolerance.

    Softmax probabilities sum to one; the tolerance is what keeps that a claim
    about the model rather than about float accumulation order.
    """
    items = value if isinstance(value, list) else []
    field = str(args.get("field"))
    total = sum(float((item or {}).get(field) or 0) for item in items)
    expected = float(args.get("total", 1))
    tolerance = float(args.get("tolerance", 1e-3))
    if abs(total - expected) > tolerance:
        return StepResult.fail(
            f"{field} sums to {total}, not within {tolerance} of {expected}"
        )
    return StepResult.ok(f"{field} sums to {total}")


def system_resources_shape(value: Any, args: dict[str, Any]) -> StepResult:
    """A `getSystemResources` record is well formed.

    Three claims the executor made inline, kept together because they are one
    question about one record: every metric that reports `supported` says where
    the number came from and none that does not report a value anyway; a GPU is
    identified by an opaque id and never by the raw vendor/device identifiers,
    which is a privacy boundary rather than a shape detail; and a requested
    sample correlates with the capabilities it was taken against.

    `sample` says whether one was asked for -- a sample that arrives
    unrequested is as much a failure as one that is missing.
    """
    problems: list[str] = []
    record = value if isinstance(value, dict) else {}

    def metric(raw: Any, label: str) -> dict[str, Any]:
        measured = raw if isinstance(raw, dict) else {}
        if measured.get("status") == "supported":
            if not (measured.get("provenance") or {}).get("source"):
                problems.append(f"{label} has no provenance source")
        elif "value" in measured:
            problems.append(
                f"{label} exposes a value with status {measured.get('status')}"
            )
        return measured

    def utilization(raw: Any, label: str) -> None:
        measured = metric(raw, label)
        reading = measured.get("value")
        if measured.get("status") == "supported" and isinstance(reading, (int, float)):
            if reading < 0 or reading > 1:
                problems.append(f"{label} is outside 0..1: {reading}")

    capabilities = record.get("capabilities")
    if not capabilities:
        problems.append("capabilities are missing")
        capabilities = {}
    metric(capabilities.get("cpu"), "capabilities.cpu")
    metric(
        (capabilities.get("memory") or {}).get("totalBytes"),
        "capabilities.memory.totalBytes",
    )
    capability_gpus = metric(capabilities.get("gpus"), "capabilities.gpus")

    raw_identity = ("vendorId", "deviceId", "subsystemId", "revision")
    capability_ids: list[str] | None = None
    if capability_gpus.get("status") == "supported":
        gpus = capability_gpus.get("value") or []
        capability_ids = [str(gpu.get("id")) for gpu in gpus]
        for gpu in gpus:
            if not gpu.get("id"):
                problems.append("GPU has no opaque ID")
            for field in raw_identity:
                if field in gpu:
                    problems.append(f"GPU exposes private identity field {field}")

    if not args.get("sample"):
        if record.get("sample"):
            problems.append("sample returned when it was not requested")
        if problems:
            return StepResult.fail("; ".join(problems))
        return StepResult.ok("capabilities valid; sample omitted")

    sample = record.get("sample")
    if not sample:
        problems.append("requested sample is missing")
        return StepResult.fail("; ".join(problems))

    utilization(sample.get("cpu"), "sample.cpu")
    memory = sample.get("memory") or {}
    metric(memory.get("usedBytes"), "sample.memory.usedBytes")
    metric(memory.get("totalBytes"), "sample.memory.totalBytes")
    metric(memory.get("processUsedBytes"), "sample.memory.processUsedBytes")
    allowance = metric(
        memory.get("processAvailableBytes"), "sample.memory.processAvailableBytes"
    )
    if allowance.get("status") == "supported":
        reading = allowance.get("value")
        if isinstance(reading, (int, float)) and reading <= 0:
            problems.append(
                f"sample.memory.processAvailableBytes is not positive: {reading}"
            )
        scope = (allowance.get("provenance") or {}).get("scope")
        if scope != "process":
            problems.append(
                f"sample.memory.processAvailableBytes carries scope {scope}"
            )
    elif args.get("platform") == "ios":
        problems.append(
            f"sample.memory.processAvailableBytes is {allowance.get('status')} on iOS"
        )

    sample_gpus = metric(sample.get("gpus"), "sample.gpus")
    if capability_ids is not None and sample_gpus.get("status") == "supported":
        gpus = sample_gpus.get("value") or []
        if capability_ids != [str(gpu.get("id")) for gpu in gpus]:
            problems.append("capability and sample GPU IDs do not correlate")
        for gpu in gpus:
            label = f"sample.gpus.{gpu.get('id')}"
            utilization(gpu.get("compute"), f"{label}.compute")
            utilization(gpu.get("encode"), f"{label}.encode")
            utilization(gpu.get("decode"), f"{label}.decode")

    if problems:
        return StepResult.fail("; ".join(problems))
    return StepResult.ok("capabilities valid; sample valid")


def texts_by_id(value: Any, args: dict[str, Any]) -> StepResult:
    """Each named result's text carries what that result was asked for.

    A batch answers several prompts at once, so "the output contains both
    markers" is not the question -- either prompt could have produced both.
    `mode: "any"` is the looser form a vision prompt needs, where several words
    would each be a right answer.
    """
    results = value if isinstance(value, list) else []
    by_id = {
        r.get("id"): (r.get("final") or {}).get("contentText") or ""
        for r in results
        if isinstance(r, dict)
    }
    expected: dict[str, list[str]] = args.get("expect") or {}
    any_mode = args.get("mode") == "any"

    for prompt_id, terms in expected.items():
        text = by_id.get(prompt_id)
        if text is None:
            return StepResult.fail(f'no result for id "{prompt_id}": got {list(by_id)}')
        lower = text.lower()
        hits = [term for term in terms if term.lower() in lower]
        if (not hits) if any_mode else (len(hits) != len(terms)):
            missing = [term for term in terms if term not in hits]
            return StepResult.fail(
                f'"{prompt_id}" is missing '
                f"{'any of ' if any_mode else ''}{missing}: {text[:160]}"
            )
    return StepResult.ok(f"{len(expected)} id(s) matched")


def streamed_each_id(value: Any, args: dict[str, Any]) -> StepResult:
    """Every named result was streamed, not just delivered.

    The batch's final results look the same whether the text arrived in one
    frame or in fifty, so a streaming test that only read the finals would pass
    with streaming switched off.
    """
    events = value if isinstance(value, list) else []
    counts: dict[str, int] = {}
    for item in events:
        if not isinstance(item, dict):
            continue
        prompt_id = item.get("id")
        event = item.get("event") or {}
        if prompt_id is None:
            continue
        if event.get("type") == "contentDelta" and (event.get("text") or ""):
            counts[prompt_id] = counts.get(prompt_id, 0) + 1
    missing = [pid for pid in (args.get("ids") or []) if not counts.get(pid)]
    if missing:
        return StepResult.fail(f"no streamed content for: {', '.join(missing)}")
    return StepResult.ok(
        "streamed " + "/".join(str(c) for c in counts.values()) + " delta(s)"
    )


def no_tool_calls_for(value: Any, args: dict[str, Any]) -> StepResult:
    """These results made no tool call.

    The other half of `tool_call_shape`: a batch where one prompt declares a
    tool and another does not is only answered if the second one stayed quiet.
    """
    results = value if isinstance(value, list) else []
    ids = args.get("ids") or []
    for prompt_id in ids:
        calls = next(
            (
                (r.get("final") or {}).get("toolCalls") or []
                for r in results
                if isinstance(r, dict) and r.get("id") == prompt_id
            ),
            [],
        )
        if calls:
            names = ", ".join(str(c.get("name")) for c in calls)
            return StepResult.fail(
                f'"{prompt_id}" was expected to make no tool call, made: {names}'
            )
    return StepResult.ok(f"{len(ids)} id(s) stayed quiet")


def fields_present(value: Any, args: dict[str, Any]) -> StepResult:
    """Every named field is present on the value.

    Replaces the inline "which required fields are missing" loops that several
    executors grew independently. Generic on purpose: the field list belongs to
    the test, not to the assertion registry.
    """
    if not isinstance(value, dict):
        return StepResult.fail(f"expected an object, got {type(value).__name__}")
    fields: list[str] = args.get("fields") or []
    # Key absence, not falsiness: JS checks `=== undefined`, so a field the SDK
    # reports as an explicit null counts as present there. Checking `is None`
    # here would fail the same record on Python and call it drift.
    missing = [field for field in fields if field not in value]
    if missing:
        return StepResult.fail(f"missing fields: {', '.join(missing)}")
    return StepResult.ok(f"{len(fields)} field(s) present")


def fields_match(value: Any, args: dict[str, Any]) -> StepResult:
    """Two records agree on the named fields.

    Compared as strings so a client that returns a number where another returns
    a numeric string is not reported as drift -- the question here is whether
    two views of the same record agree, not how each typed it.
    """
    left = value if isinstance(value, dict) else {}
    right = args.get("expected") or {}
    fields: list[str] = args.get("fields") or []
    mismatched = [
        field
        for field in fields
        if js_string(left.get(field)) != js_string(right.get(field))
    ]
    if mismatched:
        return StepResult.fail(
            "; ".join(
                f"{field}: {left.get(field)} != {right.get(field)}"
                for field in mismatched
            )
        )
    return StepResult.ok(f"{len(fields)} field(s) match")


def error_is_structured(value: Any, args: dict[str, Any]) -> StepResult:
    """The rejection carried machine-readable structure, not just a string.

    A chained cause or a present error code both answer that; which one a given
    SDK surfaces is an implementation choice, and pinning the test to one of
    them would make it a test of that choice rather than of the guarantee.
    """
    err = value if isinstance(value, dict) else {}
    code = err.get("code") or ""
    if not code and not err.get("hasCause"):
        return StepResult.fail(
            "rejection carried neither a code nor a cause: "
            f"{err.get('message') or '(no message)'}"
        )
    return StepResult.ok(
        f"hasCause={bool(err.get('hasCause'))}, code={code or '(none)'}"
    )


def non_empty_text(value: Any, args: dict[str, Any]) -> StepResult:
    """The value is a string with something in it.

    `expectedType: "string"` only asks about the type, and `minLength` in the
    expectation applies to arrays, so "it produced text" had no way to be said
    until now. Every generative category needs it.
    """
    if not isinstance(value, str):
        return StepResult.fail(f"expected a string, got {type(value).__name__}")
    if not value.strip():
        return StepResult.fail("expected text, got an empty string")
    return StepResult.ok(f"{len(value)} character(s)")


def error_matches(value: Any, args: dict[str, Any]) -> StepResult:
    """The rejection is the one the test meant, by code and by wording.

    `messageNotMatching` is the half that is easy to forget and the reason this
    is not just a `contains`: several error tests exist to prove a bad argument
    is rejected *by the SDK* rather than forwarded to the addon, and only the
    wording of the failure tells those two apart.
    """
    err = value if isinstance(value, dict) else {}
    message = err.get("message") or ""

    expected_code = args.get("code")
    if expected_code is not None and str(err.get("code")) != str(expected_code):
        return StepResult.fail(f"expected code {expected_code}, got {err.get('code')}")

    contains = args.get("messageContains")
    if contains is not None and str(contains).lower() not in message.lower():
        return StepResult.fail(f'message does not contain "{contains}": {message}')

    forbidden = args.get("messageNotMatching")
    if forbidden is not None and re.search(str(forbidden), message, re.IGNORECASE):
        return StepResult.fail(f"message matched the forbidden pattern: {message}")

    return StepResult.ok(f"code={err.get('code') or '(none)'}: {message[:120]}")


def tool_call_shape(value: Any, args: dict[str, Any]) -> StepResult:
    """The model made a structured tool call, and the right one.

    `declared` is the tools the test offered: a call naming something that was
    never declared is a failure however well-formed it looks, and that check is
    the reason this is not an ordinary field comparison.
    """
    calls = value if isinstance(value, list) else []
    if not calls:
        return StepResult.fail(
            "expected a structured tool call but the model made none"
        )

    declared = set(args.get("declared") or [])
    valid = [call for call in calls if call.get("name") in declared]
    if not valid:
        got = ", ".join(str(call.get("name") or "<unnamed>") for call in calls)
        return StepResult.fail(
            f"no tool call matched a declared tool. Got: [{got}], "
            f"declared: [{', '.join(sorted(declared))}]"
        )

    match = next((call for call in valid if call.get("name") == args.get("name")), None)
    if match is not None:
        call_args = match.get("arguments") or {}
        for key in args.get("argKeys") or []:
            if key not in call_args:
                return StepResult.fail(
                    f"tool call '{args.get('name')}' is missing argument "
                    f"'{key}': {call_args}"
                )

    return StepResult.ok(
        "tool call(s): " + ", ".join(str(call.get("name")) for call in valid)
    )


def text_block_shape(value: Any, args: dict[str, Any]) -> StepResult:
    """Every block carries the geometry a caller needs to place it.

    The OCR executors checked this inline; as a named assertion it is the same
    check on every client, which is the difference between two clients agreeing
    and two clients each having an opinion.
    """
    blocks = value if isinstance(value, list) else []
    for index, block in enumerate(blocks):
        block = block if isinstance(block, dict) else {}
        if not isinstance(block.get("text"), str):
            return StepResult.fail(f"block[{index}].text is not a string")
        bbox = block.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4:
            return StepResult.fail(f"block[{index}].bbox is not a 4-element array")
        for position, coordinate in enumerate(bbox):
            if not isinstance(coordinate, (int, float)) or isinstance(coordinate, bool):
                return StepResult.fail(
                    f"block[{index}].bbox[{position}] is not a number"
                )
        confidence = block.get("confidence")
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
            return StepResult.fail(f"block[{index}].confidence is not a number")
    return StepResult.ok(f"{len(blocks)} well-formed block(s)")


def timing_stats_present(value: Any, args: dict[str, Any]) -> StepResult:
    """The run reported how long it took.

    `field` names which timing to insist on, because the engines do not agree
    on what they measure -- and a test that only checks "stats exist" passes on
    an object full of nulls.
    """
    if not isinstance(value, dict):
        return StepResult.fail("stats is undefined, expected timing data")
    field = str(args.get("field") or "totalTime")
    measured = value.get(field)
    if not isinstance(measured, (int, float)) or isinstance(measured, bool):
        return StepResult.fail(f"expected stats.{field} > 0, got {measured!r}")
    if measured <= 0:
        return StepResult.fail(f"expected stats.{field} > 0, got {measured!r}")
    return StepResult.ok(f"{field}={measured}")


def produced_audio(value: Any, args: dict[str, Any]) -> StepResult:
    """The run produced audio.

    `minSamples` is the bar: 1 for a normal synthesis, 0 for the tests that
    feed empty text and only care that the SDK handled it rather than crashing.
    The executors asserted a synthesised sentence -- "generated N samples" --
    against `type: string`, which every string satisfies, so they could not
    fail whatever the engine did. This asks the question they meant.
    """
    if isinstance(value, (list, tuple, bytes, bytearray)):
        samples = len(value)
    else:
        samples = 0
    floor = int(args.get("minSamples", 1))
    if samples < floor:
        return StepResult.fail(f"expected at least {floor} sample(s), got {samples}")
    return StepResult.ok(f"{samples} sample(s)")


def is_true(value: Any, args: dict[str, Any]) -> StepResult:
    """The value is exactly `True`.

    For the operations whose whole answer is "it worked": the executors turned
    that into the string "success" and matched it against `type: string`, which
    is satisfied by "failed" just as well.
    """
    if value is not True:
        return StepResult.fail(f"expected true, got {value!r}")
    return StepResult.ok("true")


def positive_integers(value: Any, args: dict[str, Any]) -> StepResult:
    """Every named field is a positive integer.

    Model hyper-parameters are the recurring case: a chunk size or an action
    dimension that arrives as 0, a float, or a string is a broken model
    description however well-formed the surrounding object looks.
    """
    record = value if isinstance(value, dict) else {}
    fields: list[str] = args.get("fields") or []
    for field in fields:
        measured = record.get(field)
        if not _is_integer(measured) or measured <= 0:
            return StepResult.fail(
                f"{field} is not a positive integer (got {measured!r})"
            )
    return StepResult.ok(f"{len(fields)} field(s) positive")


def value_in(value: Any, args: dict[str, Any]) -> StepResult:
    """The value is one of a known set. `allowNull` admits "not reported"."""
    if value is None and args.get("allowNull"):
        return StepResult.ok("null")
    allowed = args.get("values") or []
    if value not in allowed:
        return StepResult.fail(f"{value!r} is not one of {allowed!r}")
    return StepResult.ok(str(value))


def field_equals(value: Any, args: dict[str, Any]) -> StepResult:
    """Two fields of the same object agree.

    For the invariants a result carries about itself -- a buffer whose length
    must equal the product of the dimensions reported beside it.
    """
    record = value if isinstance(value, dict) else {}
    left = record.get(str(args.get("field")))
    right = record.get(str(args.get("other")))
    if left != right:
        return StepResult.fail(
            f"{args.get('field')}={left!r} != {args.get('other')}={right!r}"
        )
    return StepResult.ok(f"{args.get('field')} == {args.get('other')}")


def loaded_model_info_shape(value: Any, args: dict[str, Any]) -> StepResult:
    """`getLoadedModelInfo` returned a record describing the model we loaded.

    Mirrors the checks the TypeScript executor made inline, so the migrated
    test asserts exactly as much as it did before.
    """
    if not isinstance(value, dict):
        return StepResult.fail(f"expected an object, got {type(value).__name__}")

    expected_model_id = args.get("expectedModelId")
    checks = {
        "modelIdMatches": value.get("modelId") == expected_model_id,
        "handlersIsList": isinstance(value.get("handlers"), list),
        "modelTypePresent": isinstance(value.get("modelType"), str)
        and len(value.get("modelType") or "") > 0,
    }

    expected_handler = args.get("handlerIncludes")
    if expected_handler is not None:
        handlers = value.get("handlers") or []
        checks["handlerPresent"] = expected_handler in handlers

    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        return StepResult.fail(
            f"loadedModelInfoShape failed: {', '.join(failed)} "
            f"(modelId={value.get('modelId')}, modelType={value.get('modelType')}, "
            f"handlers={value.get('handlers')})"
        )

    return StepResult.ok(
        f"modelType={value.get('modelType')}, handlers={len(value.get('handlers') or [])}"
    )


ASSERTIONS: dict[str, Callable[[Any, dict[str, Any]], StepResult]] = {
    "lengthIs": length_is,
    "lengthAtLeast": length_at_least,
    "anyFieldPresent": any_field_present,
    "containsAll": contains_all,
    "eventTypeCounts": event_type_counts,
    "transcriptSegmentsShape": transcript_segments_shape,
    "noPartialDownloads": no_partial_downloads,
    "anyElementPositive": any_element_positive,
    "sortedAscendingBy": sorted_ascending_by,
    "noProgressBatchGaps": no_progress_batch_gaps,
    "framesAre": frames_are,
    "safetensorsContainer": safetensors_container,
    "atLeast": at_least,
    "isAbsent": is_absent,
    "belowBudget": below_budget,
    "atLeastField": at_least_field,
    "jsonObjectShape": json_object_shape,
    "pngDimensions": png_dimensions,
    "nonNegativeNumbers": non_negative_numbers,
    "fieldsSumTo": fields_sum_to,
    "eventShape": event_shape,
    "containsAny": contains_any,
    "equalsJoined": equals_joined,
    "isEmptyText": is_empty_text,
    "numbersInRange": numbers_in_range,
    "sortedDescendingBy": sorted_descending_by,
    "sumsTo": sums_to,
    "systemResourcesShape": system_resources_shape,
    "textsById": texts_by_id,
    "streamedEachId": streamed_each_id,
    "noToolCallsFor": no_tool_calls_for,
    "fieldsPresent": fields_present,
    "fieldsMatch": fields_match,
    "errorIsStructured": error_is_structured,
    "nonEmptyText": non_empty_text,
    "errorMatches": error_matches,
    "toolCallShape": tool_call_shape,
    "textBlockShape": text_block_shape,
    "timingStatsPresent": timing_stats_present,
    "producedAudio": produced_audio,
    "isTrue": is_true,
    "positiveIntegers": positive_integers,
    "valueIn": value_in,
    "fieldEquals": field_equals,
    "loadedModelInfoShape": loaded_model_info_shape,
}


def _byte_length(value: Any) -> int:
    """How much data a value carries, whether it arrived as bytes or a list."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return len(bytes(value))
    if isinstance(value, list):
        return len(value)
    return 0


def _as_bytes(value: Any) -> bytes:
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    if isinstance(value, list):
        return bytes(bytearray(int(item) & 0xFF for item in value))
    return b""


def greater_than(left: Any, right: Any, _args: dict[str, Any]) -> StepResult:
    """The left number is strictly larger than the right.

    Two cache-token readings taken either side of a model reload: the second
    can only exceed the first if the cache was written to disk and read back,
    because the reload cleared everything held in memory. Equal readings mean
    the save was silently dropped.
    """
    if not isinstance(left, (int, float)) or not isinstance(right, (int, float)):
        return StepResult.fail(f"expected numbers, got {left!r} and {right!r}")
    if left <= right:
        return StepResult.fail(f"expected {left} > {right}")
    return StepResult.ok(f"{left} > {right}")


def equal_strings(left: Any, right: Any, _args: dict[str, Any]) -> StepResult:
    """The two strings are the same.

    `identical_bytes` reads buffers; a seeded completion is compared as text,
    and reporting "0 bytes differ" about two strings would be nonsense.
    """
    if str(left) != str(right):
        return StepResult.fail(
            f"differ:\n  {str(left)[:200]!r}\n  {str(right)[:200]!r}"
        )
    return StepResult.ok(f"identical, {len(str(left))} char(s)")


def identical_bytes(left: Any, right: Any, _args: dict[str, Any]) -> StepResult:
    """The two runs produced exactly the same data.

    The determinism half of a conditioning test: the same inputs twice have to
    give the same output before "changing this one input changed the output"
    means anything.
    """
    if _as_bytes(left) != _as_bytes(right):
        return StepResult.fail(
            f"expected identical output, got {_byte_length(left)} "
            f"and {_byte_length(right)} byte(s) that differ"
        )
    return StepResult.ok(f"identical, {_byte_length(left)} byte(s)")


def different_bytes(left: Any, right: Any, _args: dict[str, Any]) -> StepResult:
    """The two runs produced different data, and both produced some.

    Both halves matter: two empty results are trivially different, and a
    conditioning test that accepted them would pass against a silent engine.
    """
    if _byte_length(left) == 0 or _byte_length(right) == 0:
        return StepResult.fail(
            f"one side produced nothing ({_byte_length(left)} and "
            f"{_byte_length(right)} byte(s))"
        )
    if _as_bytes(left) == _as_bytes(right):
        return StepResult.fail("expected the outputs to differ, they are identical")
    return StepResult.ok(
        f"differ, {_byte_length(left)} vs {_byte_length(right)} byte(s)"
    )


def _png_dimensions(data: bytes) -> tuple[int, int] | None:
    """Width and height out of a PNG's IHDR, or None if it is not a PNG.

    PNG byte length varies with content and compression, so the header is the
    only reliable invariant for comparing two generated images.
    """
    signature = b"\x89PNG\r\n\x1a\n"
    if len(data) < 24 or not data.startswith(signature):
        return None
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    return width, height


def _byte_diff_ratio(left: bytes, right: bytes) -> float:
    """How much of the two buffers differs, as a fraction of the longer one."""
    longest = max(len(left), len(right))
    if longest == 0:
        return 0.0
    changed = abs(len(left) - len(right))
    changed += sum(1 for a, b in zip(left, right) if a != b)
    return changed / longest


def image_diverges_from(left: Any, right: Any, args: dict[str, Any]) -> StepResult:
    """Two images of the same size, far enough apart to prove the input mattered.

    The img2img and fusion tests run the same prompt and seed twice, dropping
    the reference image from one. A backend that silently ignored the reference
    would produce two nearly identical outputs, so the claim is a floor on how
    much they differ -- and equal dimensions first, because comparing a 512x512
    against a 768x768 says nothing.
    """
    a, b = _as_bytes(left), _as_bytes(right)
    if not a or not b:
        return StepResult.fail(f"missing output ({len(a)} and {len(b)} bytes)")
    da, db = _png_dimensions(a), _png_dimensions(b)
    if da is None or db is None:
        return StepResult.fail("one of the outputs is not a valid PNG")
    if da != db:
        return StepResult.fail(
            f"dimensions differ: {da[0]}x{da[1]} vs {db[0]}x{db[1]} -- the "
            "comparison is only meaningful at equal size"
        )
    ratio = _byte_diff_ratio(a, b)
    minimum = float(args.get("minRatio", 0.01))
    if ratio <= minimum:
        return StepResult.fail(
            f"outputs are {ratio * 100:.2f}% apart, at or below the "
            f"{minimum * 100:.2f}% floor -- the input was probably dropped"
        )
    return StepResult.ok(f"{ratio * 100:.2f}% byte delta")


def length_ratio_at_least(left: Any, right: Any, args: dict[str, Any]) -> StepResult:
    """The left value carries at least this many times the data of the right.

    The strongest claim available about an output sample rate: the rate itself
    is not exposed through the public result, but a native-rate run has to
    produce proportionally more samples than a downsampled one.
    """
    left_size, right_size = _byte_length(left), _byte_length(right)
    if left_size == 0 or right_size == 0:
        return StepResult.fail(
            f"comparison produced empty output ({left_size} and {right_size})"
        )
    minimum = float(args.get("ratio", 1))
    ratio = left_size / right_size
    if ratio < minimum:
        return StepResult.fail(
            f"ratio too low: {ratio:.2f} < {minimum} ({left_size} vs {right_size})"
        )
    return StepResult.ok(f"ratio {ratio:.2f} ({left_size} vs {right_size})")


#: Checks that take two bound values rather than one. Kept beside the
#: assertions so both clients read one list.
COMPARISONS: dict[str, Any] = {
    "equalStrings": equal_strings,
    "greaterThan": greater_than,
    "identicalBytes": identical_bytes,
    "differentBytes": different_bytes,
    "lengthRatioAtLeast": length_ratio_at_least,
    "imageDivergesFrom": image_diverges_from,
}
