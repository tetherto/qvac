# Conforming test runner

What a client must do to run the shared test catalog. Companion to
[`schema/test-definition.schema.json`](../schema/test-definition.schema.json),
which says what shape is legal; this says what a runner must **do** with a
legal definition. Both are needed — two clients can satisfy the schema and
still disagree about what a test means.

Written as obligations ("a runner MUST…") so an implementation can be checked
against it.

Keep the operation set small: every operation is multiplied by the number of
clients.

---

## 1. What a runner is

A runner executes one test definition and reports one outcome. It does not
own the queue, retries, timeouts, or reporting — the framework does. This is
what keeps a new client to an interpreter rather than a port of the suite.

A runner MUST:

- accept a definition, execute its `steps` in order, and return exactly one
  outcome;
- drive the SDK under test through its **public client surface**. A runner
  that reaches past the client into the worker proves only that the engine
  works, which is not the question this catalog asks;
- keep its transport swappable, so a test can substitute a fake.

**Teardown.** A definition may carry `finally`, a second step list. A runner
MUST run it whether the body passed, failed or threw, in the body's own scope —
teardown usually needs what the body bound, and a binding the body never
reached is referenced optionally. A failing teardown fails a passing body: a
test cannot be claimed on a client that could not clean up after it. A body
that already failed keeps its own diagnosis.

---

## 2. Outcomes

Four states. Only one of them is a claim.

| Outcome      | Meaning                                              | Who it is about |
| ------------ | ---------------------------------------------------- | --------------- |
| `pass`       | Ran, and the assertion held.                         | —               |
| `fail`       | Ran, and the assertion did not hold.                 | —               |
| `skipped`    | Platform policy says the test does not apply here.   | the platform    |
| `incomplete` | The test applies, but this client cannot run it yet. | the client      |

A runner MUST NOT report `pass` for a test it did not execute to an assertion.

A runner MUST report `incomplete`, never `fail`, when:

- a step operation is not implemented;
- an SDK method named by a `call` is not wired up;
- a `collect` mode is not implemented;
- a named assertion or comparison is not in its registry;
- a resource key is not in its resource table;
- the expectation is `validation: "function"` — a JavaScript closure cannot
  cross the wire.

Every `incomplete` MUST carry a human-readable reason. The reason is the
difference between a tracked gap and an unexplained hole.

A runner MUST NOT decide `skipped` for itself. Platform policy lives in the
catalog and is applied by the framework.

---

## 3. Scope and references

Each step may bind a value under a name with `as`. A later step reads it back
as `$name`.

- `$name` — a value a previous step bound.
- `$params.x` — a field of the definition's own `params`, dotted paths allowed.
- Paths may index: `$result.blocks[0].text`.
- A trailing `?` marks the reference **optional**: `$params.tools?`.
- A string that does not begin with `$` is a literal.

A runner MUST resolve references recursively inside `call.params` — including
inside nested objects and arrays — so a parameter can be built from several
bound values.

Resolving a **required** reference that does not exist MUST fail the test, not
return `undefined` silently. A test that asserts on nothing must never look
like a pass.

**Optional references.** A `?` reference that does not resolve produces
nothing, and a `call` or `callError` parameter that resolves to nothing MUST be
**left out of the call entirely**, not passed as null. An SDK that tells
"absent" apart from "explicitly nothing" would otherwise see a different call
than the test meant to make, and the two clients would then have to agree on
which. Without this every test with an optional argument would have to restate
its own params inside its own steps purely to omit one of them.

**`$model`.** After a `useModel` step, a runner MUST bind the first declared
model id as `$model` if nothing is bound under that name yet, so the common
single-model test needs no explicit `as`.

---

## 4. Model lifecycle

Around each test, a runner MUST:

1. evict every loaded model **not** declared by that test's `useModel` steps,
   before the first step runs;
2. load what the test declares, on demand.

The order matters and is not an optimisation: without eviction first, a run
becomes sensitive to the order tests happened to arrive in, and on a
memory-constrained platform the previous model's pages are still resident
when the next one allocates.

`useModel.deps` is a list, not a single key. Some tests genuinely need two
models at once.

---

## 5. What the operations oblige a runner to do

Which operations exist, which fields each one takes and what each one is for is
in `schema/test-definition.schema.json`. That is the copy a client reads and
generates stubs from, and it is checked against the framework's own schema by
`qvac-test catalog:validate`. It is not repeated here.

What a schema cannot state, and a runner MUST do anyway:

**`asset`** — refuse a `file` that resolves outside the asset root for its
`kind`. A definition is data that travels between clients, so the name cannot
be trusted merely because today's catalog contains only literals. `form` says
what to bind: `bytes` (the default) for the contents, `path` for a reference
the SDK can open itself.

**`call` / `start` — fold a stream the way the reference client folds it.** This
is the single most likely place for two clients to differ while both reporting
`pass`, which is what the cross-client value comparison exists to catch.

| mode     | meaning                     |
| -------- | --------------------------- |
| `text`   | concatenate the text deltas |
| `blocks` | collect structured blocks   |
| `events` | collect the events in order |
| `pcm`    | assemble audio frames       |
| `last`   | keep only the final frame   |
| `all`    | keep every frame as a list  |

**`settle`** — with `withinMs`, fail the step when the call has not settled
that many milliseconds after the wait began. The call is not abandoned: it is
drained after teardown like any call the body never settled.

**`callError`** — if the call *succeeds*, fail the test. An error test that
silently passes on success is worse than no test.

**`repeat`** — `collectInto` binds what the **last binding operation** of the
nested list produced, whichever kind it is: `project`, `call`, `settle`,
`asset` or `modelSource`. A failing check inside the loop stops the repeat
rather than contributing a half-built value.

**`assert`** — a body may assert more than once, and a runner MUST stop at the
**first failing** check and report it. Reporting whichever assertion ran last
would let a later passing check mask an earlier failure. Record the asserted
value alongside the verdict (see §7).

---

## 6. Expectations

`expectation` is shared data, so every client MUST read it identically. The
reference semantics are in
`packages/test-suite/src/utils/validation-helpers.ts`; the details that are
easy to get subtly wrong, and therefore MUST be matched:

- `contains-all` / `contains-any` compare **case-insensitively**, after
  coercing the value to a string;
- coercion follows JavaScript's `String(value)` — notably, an array joins its
  elements with commas, and `null` becomes `"null"`;
- `type` treats an array as `"array"`, not `"object"`;
- `numeric-range` bounds are inclusive;
- failure output truncates the observed value at 200 characters.

A disagreement between two clients must be a real disagreement about the
result, never about how the expectation was read.

---

## 7. Reporting

For every test a runner MUST return: the outcome, a human-readable output or
reason, and — for any test that reached an assertion — **the value the
assertion ran against**, summarised.

The asserted value is not diagnostics. Most expectations correctly assert only
that a result of the right kind came back, because model output is not
deterministic; two clients can both return a string and disagree about what
they built from the same stream. The verdict cannot catch that. Comparing the
asserted value can.

Summarisation MUST be stable across clients — the same input produces the same
summary — or the comparison reports drift that is not there. The reference
summary keeps a collection's kind and length plus its first eight elements,
recursively, and truncates long strings.

---

## 8. Determinism and the worker

Every client MUST be pointed at the same worker build, via `QVAC_WORKER_PATH`.
The e2e suite does not use a stock worker: it bundles its own with a specific
plugin set, including a test-only plugin. With both clients on that binary the
engine is identical by construction, so any difference in a result can only
have come from the client. Without it, the comparison means nothing.

A client that spawns the worker itself MUST make it a child process, or report
memory as not collected. The framework's memory sampler sums a process tree; a
client that re-parents the worker or attaches to a shared one would silently
under-count, and a number that looks comparable but is not is worse than no
number.

---

## 9. Checklist for a new client

1. Interpret every operation the schema declares, or report `incomplete` with
   a reason for the ones you do not.
2. Mirror the expectation semantics of §6 exactly.
3. Implement the resource table for the keys your categories need.
4. Evict-then-load around every test.
5. Record the asserted value with a stable summary.
6. Honour `QVAC_WORKER_PATH`.
7. Keep the transport swappable.
8. Generate a stub per operation from the JSON Schema that fails loudly when
   unimplemented, so `incomplete` is enforced by the code rather than by
   convention.
