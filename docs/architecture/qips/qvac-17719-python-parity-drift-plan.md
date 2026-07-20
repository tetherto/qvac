# Python/JS parity — drift-avoidance plan

Follow-up to the QVAC-17719 Python-client QIPs (thin client / worker-extraction /
notebook distribution). The concern this plan answers: **the JS and Python
clients must not drift.** Drift lives only where the same behavior is
hand-maintained in two languages at once. Everything derived from the single
contract (`packages/sdk/contract/{schema,manifest}.json`) cannot drift — change
the schema, regenerate, both clients follow.

## Guiding principle (QIP-2)

> Phase 1 generates every method that can be generated from the schemas. Simple
> stream-to-result assembly is already handled client-side in phase 1; it's the
> tool-running loop and MCP that are the problem.

So: **generate what's generatable; move genuinely un-generatable behaviour into
the worker; hand-write per language only what is irreducibly client-side, and
never *trust* it — guard it with cross-language conformance tests.**

## Current manual surface (measured)

Hand-written Python that mirrors JS behaviour is ~2,669 LOC. Split:

- **~1,900 LOC client-side by design** — completion assembly + tool-callback
  glue, typed error *shapes*, duplex session state, logging fan-in, profiling,
  vla numpy marshaling. Any language binding hand-writes these.
- **~740 LOC off-principle** — `api.py`'s request-shaping wrappers (should be
  generated) plus two genuine logic ports: `translate` langdetect and
  `loadModel` type-inference (should live in the worker).

## Phases

| # | Phase | What | Removes drift by | Depends on |
|---|---|---|---|---|
| **A** | Generator ergonomics | Generated request models construct directly (snake_case via `populate_by_name`; defaulted `type` discriminator via `--use-one-literal-as-default`), so a generated method is usable without a hand-wrapper. Optional follow-up: emit kwargs signatures + `requestId` auto-injection. | making the contract the single source for all request shaping | — |
| **B** | Move the 2 logic ports into the worker | `translate` language auto-detection and `loadModel` type-inference/alias resolution move server-side; regenerate, delete the Python (and shrink the JS) client logic. | single-sourcing genuine behaviour (revisits QVAC-21970/21971) | — (cross-team: SDK pod) |
| **C** | Generate the error-code → class table | source `SDK_*_ERROR_CODES`/`RAG_ERROR_CODES` into the contract; generate the `RECONSTRUCTORS` map; hand-keep only base class shapes. | closing "JS adds a code, Python silently can't reconstruct it" | — |
| **D** | Shared conformance corpus | extract `packages/sdk/e2e/tests/test-definitions` into data both the JS suite and a Python runner consume; assert identical outputs. | asserting identical outputs for identical inputs across both clients | A, B |
| **E** | Flatten public API + parity guard | dissolve `qvac.api`/`qvac.completion` into flat `qvac`; keep `qvac.models`; demote `schemas`/`methods` to advanced. Parity-guard test: every `client/api` export has a `qvac` equivalent. | ergonomics + a regression guard | A |
| **F** | Thin wheel + npm-pinned worker | pin `@qvac/sdk` version into the package; add npm-resolution tier + `python -m qvac install-worker`. | runtime client/worker contract mismatch | — |

Sequence: A → (C, E in parallel) → B (cross-team track) → D (after A+B) → F (own track).

## End state

The only hand-written Python that mirrors JS is the ~1,900 LOC of
irreducibly-client-side code, and none of it is trusted to match — it is
generated, single-sourced in the worker, or diffed against JS on every CI run.
