# Conforming test runner

_Status:_ Draft — the vocabulary is not frozen
_Implements:_ QIP QVAC-24683
_Companion to:_ `packages/test-suite/schema/test-definition.schema.json`

A schema says what shape is legal. It does not say what a runner must **do**
with a legal definition. Those are two documents, and both are needed: without
this one, "one interpreter per client" is not reproducible by someone who was
not in the original discussion, and two clients can both satisfy the schema
while disagreeing about what a test means.

This document is what a client implementation is checked against. It is
deliberately written as obligations ("a runner MUST…") rather than as prose
about the design.

> **Not frozen.** The vocabulary was read off the existing TypeScript
> executors and has so far been exercised by one category on two languages.
> It freezes once several categories with different shapes have run. Until
> then, treat additions as likely and keep the operation set small: every
> operation is multiplied by the number of clients.

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

## 5. The operations

### `useModel { deps, as? }`

Load the models behind these resource keys. Binds the id (one key) or the list
of ids (several).

### `modelSource { dep, as }`

Bind what `loadModel` would be called with for this resource key, **without
loading it**. A test that drives the load path itself needs the model source as
data, and the source is the one thing a definition cannot write down: it is a
per-client constant. The resource table already holds it, so the step asks the
table rather than putting a filesystem path in the catalog. A runner with no
resource table reports `incomplete`.

### `asset { kind, file, form?, as }`

Resolve a bundled test asset for this platform — a filesystem path on desktop,
a bundled-asset URI on mobile. A runner with no asset resolution reports
`incomplete`.

`form` says what to bind: `bytes` (the default) for the contents, `path` for a
reference the SDK can open itself. Which one an API wants is part of its
contract, and the `path` form is what a filesystem path and a bundled-asset URI
have in common.

A runner MUST refuse a `file` that resolves outside the asset root for its
`kind`. A definition is data that travels between clients, so the name cannot
be trusted merely because today's catalog contains only literals.

`kind` and `file` resolve like any other value, so a category whose tests differ
only in which fixture they use carries one body and names the file in its
params.

### `call { method, params?, as?, collect? }`

One SDK call. `method` is the name as it appears in the contract manifest.
The result is bound under `as`, or under `result` if `as` is absent.

`collect` says how a streaming result is folded into one value:

| mode     | meaning                     |
| -------- | --------------------------- |
| `text`   | concatenate the text deltas |
| `blocks` | collect structured blocks   |
| `events` | collect the events in order |
| `pcm`    | assemble audio frames       |
| `last`   | keep only the final frame   |
| `all`    | keep every frame as a list  |

A runner MUST fold streams the same way the reference client does. This is the
single most likely place for two clients to differ while both reporting
`pass`, which is exactly what the cross-client value comparison exists to
catch.

### `callError { method, params?, collect?, as }`

A call expected to fail. Binds `{ code, message, hasCause }` — `code` as a
string, empty when the rejection carried none; `hasCause` true when it was
chained onto another error. Those two are what an "errors are structured" test
asks about, and binding them here keeps that answerable without a step that
reaches into a language's exception object.

`collect` folds the streaming result before deciding the call failed. A
streaming call typically rejects only once its result is awaited, so without it
an error test on a stream would see the call resolve and report a false pass.

If the call **succeeds**, the test MUST fail — an error test that silently
passes on success is worse than no test.

### `repeat { over, as, collectInto, steps }`

Run the nested steps once per item of `over`.

- Each iteration MUST get its own scope, so a binding from one item cannot
  leak into the next.
- `collectInto` binds the list of per-iteration results. The value collected
  is whatever the **last binding operation** of the nested list produced —
  the last `project`, else the last `call`, else the last `asset`.

### `project { from, path, join?, as }`

Pull a field out of a bound value. `join` concatenates a projected list with
the given separator.

### `assert { on, use? | named? }`

Check a bound value. Exactly one of:

- `use: "expectation"` — check against the definition's own `expectation`;
- `named: "<name>"` — check with a shared named assertion. `with` carries its
  arguments, reference-resolved, so a check can compare the result against
  something the test set up rather than only against a constant.

A runner MUST record the asserted value alongside the verdict (see §7).

**Several checks in one body.** A test body may assert more than once — the
shape of a result, then its length, then its value — and a runner MUST stop at
the **first failing** check and report it. A migrated executor usually becomes
exactly this, and reporting whichever assertion ran last would let a later
passing check mask an earlier failure. A failing check inside a `repeat` MUST
stop the repeat rather than contribute a half-built value to `collectInto`.

### `compare { left, right, named }`

Compare two bound values with a shared named comparison.

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

1. Interpret the nine operations, or report `incomplete` with a reason for
   the ones you do not.
2. Mirror the expectation semantics of §6 exactly.
3. Implement the resource table for the keys your categories need.
4. Evict-then-load around every test.
5. Record the asserted value with a stable summary.
6. Honour `QVAC_WORKER_PATH`.
7. Keep the transport swappable.
8. Generate a stub per operation from the JSON Schema that fails loudly when
   unimplemented, so `incomplete` is enforced by the code rather than by
   convention.
