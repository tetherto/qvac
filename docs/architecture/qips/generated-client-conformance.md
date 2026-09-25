# QIP: Proving generated SDK clients match JS for a release

*Status:* Posted for review — reviewed by @Lauri Piisang and @Opanin
*Authors:* @victor.rodzko
*Created:* 2026-09-10
*Task:* QVAC-24683

Companion to Python QIP 1 (QVAC-17719): that one builds the clients, this one
proves them. No Kotlin or Swift work is proposed here.

---

## People to consult before posting

• *SDK pod lead* (`packages/sdk`, `packages/sdk/e2e`) — owns the e2e catalog and the five existing JS consumers
• *`@qvac/test-suite` owner* — this changes the public config surface and `TestDefinition` of a package published to public npm
• *`packages/sdk-python` owner* — the first non-JS consumer, and the source of the missing client wrappers this exposes
• *Kotlin client owner* (QVAC-24535) — not asked to build anything here, but the design assumes the client keeps an injectable transport
• *AQA / QA lead* — owns the release claim matrix this produces
• *DevOps / CI* — a per-client leg reuses the existing GPU runners and model cache
• *Lead / Architect* — cross-package contract change, Principle 2 and Principle 6 impact

---

## Approvers

The following approvers are required in priority order: TL approval,
Lead/Architect for technical validation, Head of QVAC for final executive
approval.

| Role | Approver | Status |
| --- | --- | --- |
| TL | @Opanin | |
| Lead / Architect | @Dima / @Yury Samarin | |
| Head of QVAC | @Marco | |

---

## :mag: Problem

**The bar.** For a given SDK release, can we say the same features work on JS,
on Python, and later on Kotlin, with confidence? Today the honest answer is no
for everything except JS.

The TypeScript SDK (`@qvac/sdk`) is the reference. The Python client
(`tetherto-qvac-sdk`) is released, versioned in lock-step with it, and named as
a first-class surface in `docs/architecture/ARCHITECTURE.md`. Kotlin is moving
into the monorepo under QVAC-24535 and Swift is expected after it, so this is a
per-client question we are about to have three or four times.

**Why we cannot answer it today.** Our e2e suite splits in two: a catalog of 514
plain-data definitions (`test-definitions.ts`), and executors — 60 TypeScript
classes, 11,937 lines — that take those params, make the SDK calls and check the
results. The producer sends a consumer only a `testId`; params and expectation
are resolved from TypeScript bundled into the consumer, so a consumer is a
TypeScript bundle by construction — which is why no other language can be one.
The framework also never validates anything itself: each executor calls the
shared validator on its own, and 56 expectations are JavaScript functions rather
than data.

So the Python client has no relationship to the catalog. It has 175 hand-written
pytest tests, and the two that aim at cross-client evidence both show the
problem: a shared JSON corpus of nine cases run by both clients — the right
idea, at 1.8% of the catalog — and `test_e2e_sdk_parity.py`, which re-states e2e
expectations in Python by hand. That copy is the only place we compare the two
clients on real work.

The obvious fix — a consumer type per language with the executors ported to it —
costs languages × tests: four hand-maintained copies of the same test logic,
each free to drift, and another for every client after that.

---

## :bulb: Solution

Make the test body data instead of code, keep the MQTT orchestration we already
have, and add a client by writing an interpreter rather than a test suite.

**What approvers are asked to approve** is the shape, not the volume: a shared
test catalog, one interpreter per client rather than a port of the suite, JS
interpreting that same catalog as the reference implementation, and the
four-state claim grid that decides what a release may say.

`TestDefinition` gains an optional `steps` array — operations any language can
execute: load the declared models, resolve an asset for this platform, make one
call and fold its stream, pull a field out, assert. Eight cover the executors
surveyed. A definition without `steps` keeps running through its executor, so
migration is per-test and reversible. Checks beyond "contains this string"
become a named-assertion registry written once per client, and a JSON Schema
beside the catalog enumerates both. Skip policy and the resource table move into
the catalog too, since an interpreter in another language cannot see rules that
live in TypeScript. A client attaches through one generic external consumer, in
bridge mode so the MQTT protocol stays implemented once.

**This works because the test bodies are already one repeated template.**
Classifying all 514 definitions by executor shape gives 477 of the same pattern
— load the declared model, one SDK call, pull a field out, check it — and 37
genuinely imperative. Migrating the 477 pays for itself on JS alone.

**The release claim becomes a generated artifact.** A `report:matrix` command
folds the per-run JSON reports into a testId × client matrix, and a release may
claim a feature works on a client only where that matrix says **pass**:

- **pass** — ran and passed. The only state a claim may rest on.
- **fail** — ran and failed. Blocks the claim.
- **skipped** — platform policy says the test does not apply here, and the
  catalog says why. About the platform.
- **incomplete** — new. The test applies but this client has not implemented it.
  About the client: a debt with an owner, which should shrink release over
  release.

Skipped and incomplete are the standard xUnit pair, and neither is a pass.
Because the catalog is shared, every test has a row for every client — a client
cannot quietly drop a test, only land in one of the four states with a reason.

---

## :dart: Scope

What a non-JS leg may leave out is expressed as suite tags, using the producer's
existing `--exclude-suite`: `engine-quality` (about the model's output, not the
client — proven once on the JS legs), `packaging` (Electron Forge, asar, Snap
confinement), `imperative` (the 37 tests whose bodies cannot be data), and
`host-idiomatic` (behaviour a client expresses in its own idiom). Which tests
deserve which tag is the hardest judgement here, and these four are a starting
shape.

The first client is Python on desktop — macOS, Linux and Windows, matching its
release wheels. Electron and Snap test how the JS SDK is packaged, and Python
has no such distribution; iOS and Android are out of reach because there the
worker runs inside the app as a Bare worklet rather than as a child process.
Mobile is for Kotlin and Swift to fill in, not Python.

The first bar that changes what a release can claim is Python green on the smoke
subset: 87 of 107 today (7 imperative plus 13 needing Python aggregation
wrappers), and 100 of 107 once those wrappers land.

**Explicitly out of scope:** implementing the interpreter or any runner, growing
`conformance/cases.json`, CI wiring for a per-client leg, any Kotlin or Swift
client work, adding the missing Python wrappers (identified here, decided
separately), and making the Python leg a required merge check.

---

## :twisted_rightwards_arrows: Alternatives considered

Seven options were weighed; three are the near misses. A consumer type per
language with ported executors is rejected above: languages × tests. Growing
`cases.json` expresses only what its case DSL expresses and stays outside the
e2e reports, so it is kept as a fast subset rather than the answer. Golden
envelope vectors freeze the worker's replies, so a real engine change reads as a
pass — kept as a pre-filter. The other four, with the reasoning, are in the
appendix.

---

## :scales: Consequences

**What this buys.** A client costs one interpreter, one `ResourceManager` and
one named-assertion set instead of a suite port — a cost that scales with the
step vocabulary, not with the catalog. Per-platform policy becomes reviewable
data. JS benefits directly: one interpreter absorbs most of the 60 executors,
and the `node/` versus `mobile/` split collapses into the asset step.

**Trade-offs reviewers must accept.**

- Migrating 477 tests is the bulk of the work — mechanical and self-verifying,
  but large and sustained. Approving the shape means accepting that the
  migration follows.
- Two vocabularies become contracts that are hard to change once migration
  starts — the step operations and the platform names. Additions multiply by the
  number of clients, so a ninth operation must be justified.
- 37 tests stay hand-written per client, and read *incomplete* for a client
  until someone writes them.
- Python's matrix is capped near 78% until ergonomic wrappers land for the
  streaming methods — product work outside this QIP, tracked as *incomplete*
  cells.
- One non-additive change inside the repo: the 56 `validation: 'function'`
  expectations become named assertions. The function kind stays in
  `@qvac/test-suite` for external consumers, so the published contract is
  unaffected.
- Every generated client must keep a swappable transport so a test can
  substitute a fake. Python and JS already do; retrofitting one later is
  expensive.

**Compatibility.** `@qvac/test-suite` changes are additive and warrant a minor
release; existing configs, commands, consumers and MQTT messages keep working.
Trust boundary unchanged, and no product code path changes. Detail and risks are
in the appendix.

**Assumption to confirm.** The Python leg starts label-gated on the existing
self-hosted GPU runners and becomes a required check only once coverage is
stable. If reviewers want it required earlier, the phasing changes but the
design does not.

---

## :paperclip: Appendix

Reference detail, kept out of the main reading path.

Counts in this document were measured from the built catalog at commit
`66a40af31`. They move as the catalog grows; the argument does not.

### Prior art worth stealing from

MongoDB implements the same protocols across a dozen drivers and solved this
problem with a Unified Test Format — declarative test files, one source, every
driver runs them. Their format is specified at
[mongodb/specifications](https://github.com/mongodb/specifications/blob/master/source/unified-test-format/unified-test-format.md),
which states exactly how a conforming runner must behave, and the reasoning
behind it is written up in
[The Polyglot's Dilemma](https://emptysqua.re/blog/polyglots-dilemma/). Three
parts of it map directly onto decisions above: an entity map of named
references, which is what `as` and `$name` are; operations executed in declared
order, which is what a step list is; and `runOnRequirements` gating a test to
environments it applies to, which is what moving platform policy into the
catalog does.

Two of their choices are worth considering beyond what is proposed here. They
assert on three layers — the returned value, side effects that are not in the
return value, and final state — where this proposal only asserts on the returned
value; that gap is part of why 37 tests stay imperative, and their format
suggests some of it could become data later. And their format captures expected
wire commands in the test file itself, which folds the golden-envelope idea into
the same artifact instead of keeping it as a separate mechanism. Neither is
proposed now; both are reasons to keep the step format extensible.

### Where the catalog lives, and the platform vocabulary

Two decisions the proposal makes rather than defers, because both are expensive
to change later.

The catalog starts at `packages/sdk/e2e/catalog/` — with the tests whose author
already owns them — and moves to its own package once a second client is green
on it, since at that point `sdk/e2e` is no longer its only consumer. Our
published architecture principles (`docs/architecture/PRINCIPLES.md`) hold in
Principle 3 that modularity is a property of contracts rather than of package
count, so the split is deferred until a second consumer makes it real rather
than done speculatively.

The platform vocabulary distinguishes OS as well as consumer type, because such
skips already exist: `desktop-macos`, `desktop-linux`, `desktop-windows`,
`electron-macos`, `electron-linux`, `electron-windows`, `snap-linux`,
`mobile-ios`, `mobile-android`, and per client thereafter
(`python-desktop-macos` and so on). Existing values stay valid; the three
definitions that use `skip.platforms` today keep working.

### What happens to the existing Python tests

The 175 tests in `packages/sdk-python/tests` stay, and become the
language-native layer: mocked unit tests, the generation drift check, the
transport tests, and eventually that language's copies of the 37 imperative
tests. No duplication is intended in the other direction: the real-worker parity
tests that overlap catalog coverage are retired as the catalog takes them over,
and `test_conformance.py` keeps driving the shared corpus until the catalog
supersedes it. Retirement has one condition though — only where the catalog
asserts at least as much. `embed-semantic-similarity` checks that an array came
back; the Python parity test checks that related texts embed closer than
unrelated ones. Retiring the latter as "covered" would lose a real assertion.

### Scope of the first client

The release wheels cover `darwin-arm64`, `darwin-x64`, `linux-x64`,
`linux-arm64` and `win32-x64`. The e2e leg itself does not depend on those
wheels: it points the client at the checkout's worker via `QVAC_WORKER_PATH`,
which is also what makes the cross-client comparison exact. What the Electron
and Snap consumers actually test is packaging — Electron Forge, asar, our own
Forge plugin, strict Snap confinement, the graphics content interface — which is
why no generated client has an equivalent.

### The catalog

A definition with `steps` is executed by an interpreter, and every migration is
verified against the JS legs before the test counts as migrated.

Along with the test body, the interpreter takes over the model lifecycle that
executors own today: before a test, evict everything the test does not declare
and load what it does; after it, evict what has gone unused. That is where the
resource keys are resolved.

A test body becomes a short list of steps. Each step can bind its result to a
name with `as`; a later step reads it back as `$name`, and `$params.x` reads the
test's own params.

```
useModel   { deps, as }                      -> load the model(s) behind one or more resource keys
asset      { kind, file, as }                -> resolve a bundled test asset for this platform
call       { method, params, as, collect? }  -> one SDK call; collect says how to fold a stream
                                                (text | blocks | events | pcm | last | all)
callError  { method, params, as }            -> a call expected to fail; binds { code, message }
repeat     { over, as, collectInto, steps }  -> run steps per item (embedding a list of texts)
project    { from, path, join?, as }         -> pull a field out: a.b[0].c, blocks[*].text
assert     { on, use | named }               -> check with the test's expectation, or a named check
compare    { left, right, named }            -> compare the results of two runs
```

The eight operations were read off the existing executors rather than designed
up front — full bodies for a representative sample across categories, handler
surface for the rest. They are not yet proven against all 60, which is why Phase
1 migrates a whole category before the vocabulary is frozen. Two tests already
need `useModel` to take more than one key (`llm+embeddings` and
`tts-supertonic+tts-supertonic-8k`), which is why it takes a list.

The remaining gap is checks that are more than "contains this string" or "is an
array". Today they live in two places: the 56 JavaScript-function expectations
in the catalog, and private methods inside executors — verifying that OCR text
blocks have a four-number bounding box and a confidence in range, that a tool
call names a declared tool, that timing stats are positive numbers, that a VLA
model reports the expected hyper-parameters, that a WAV header carries the
sample rate the test asked for. All of these become a named-assertion registry:
a table from a name to a function taking the value and returning pass or fail,
on the order of 40–60 entries, written once per client rather than once per
test. With that, a test definition is entirely data.

Once it is data, the format itself gets a JSON Schema sitting beside the
catalog: which operations exist, which fields each one requires, which assertion
names are legal. That is the same doctrine the SDK already runs on —
`packages/sdk/contract/**` is JSON Schema plus a manifest, and every client is
generated from it — so this is the existing pattern applied to a second artifact
rather than a new idea. It buys three things. CI validates every definition, so
a malformed step fails before a run rather than during one. The two vocabularies
stop being prose and become checkable, which is what makes the trade-off about
them an enforceable commitment rather than a promise. And because the schema
enumerates the operations, each client can generate a stub per operation that
fails loudly when it is not implemented — which turns *incomplete* from a
reporting convention into something the code enforces.

A schema says what shape is legal; it does not say what a runner must do with
it. Those are different documents, and MongoDB ships both — their prose spec
states exactly how a conforming implementation has to behave. We need the
equivalent, and it is what makes "one interpreter per client" reproducible by
someone who was not in this discussion. It is written when the vocabulary
freezes at the end of Phase 2, not up front, because before that it would only
describe a guess.

### Platform policy moves into the catalog

Not every test runs everywhere, and today the rules for that are code rather
than data. The catalog does have a field for it — a test can declare
`skip.platforms` — but only 3 of 514 tests use it. The rest is expressed as
matchers registered in each consumer's entry file — regexes plus a few explicit
id lists — which claim test ids and report them as skipped. On mobile, some of
those matchers are chosen at runtime depending on whether the app is on iOS or
Android. The result:

| Platform | Runs | Skipped | Skip rules |
| --- | ---: | ---: | ---: |
| desktop | 513 | 1 | 1 |
| electron | 453 | 61 | 7 |
| snap | 454 | 60 | 6 |
| mobile-android | 381 | 133 | 16 |
| mobile-ios | 369 | 145 | 16 |

363 tests run on all five. Three things move:

- **Skips, with their reasons.** `skip.platforms` is already a string array, so
  the shape holds; it needs a platform vocabulary that distinguishes OS as well
  as consumer type, because such skips already exist (13 OCR tests plus an OCR
  logging test off on iOS for ONNX/CoreML OOM, 2 parakeet stream tests off on
  Android as flaky). The reasons are the only record of why the matrix looks the
  way it does and must travel with the rules.
- **The resource table** — the map from a resource key to a model plus its load
  configuration. It also lives in the consumer entry files today, and the
  overlap is high but not total. Desktop declares 54 resources, Electron 40,
  mobile 36. Electron's 40 are a strict subset of desktop's, with identical
  configuration throughout. Mobile's 36 are also a subset, and 33 of them are
  identical; the three that differ are instructive, because they are three
  different kinds of difference and the shared table has to express all of them:
  - `tts-chatterbox` and `classification` differ only in resolving a test asset
    — a filesystem path on desktop, a bundled-asset URI on mobile, which is why
    mobile declares those configs as async functions. A shared table expresses
    this as a placeholder such as
    `"referenceAudioSrc": "@asset:audio/transcription-short-wav.wav"`, resolved
    per platform.
  - `ocr` differs by a genuine tuning value: mobile sets `canvasSize: 1280` and
    desktop does not. So the table needs real per-platform config overrides, not
    only asset placeholders.
  - 18 resources are absent on mobile on purpose, so the pre-download pass does
    not fetch models its tests never run — the π₀.₅ VLA weights alone are
    3.9 GB.

  Two per-platform knobs travel with the table as well: how many models to
  download in parallel, and a mobile-only pause after unloading a model —
  without it the next load arrives while the previous model's pages are still
  resident and the GGML allocator crashes on iOS.
- **Asset resolution**, as the `asset` step. This is why the OCR tests have two
  executors today, one under `node/` and one under `mobile/`, differing only in
  how they obtain the image.

### Consumers

The framework gains one generic external consumer rather than a type per
language:

```js
consumers: {
  external: [
    { name: 'python', platform: 'desktop-python', mode: 'bridge',
      interpreter: '.venv/bin/python', args: ['-m', 'qvac_e2e.runner'], cwd: '.' }
  ]
}
```

In bridge mode the framework keeps its existing MQTT state machine in Node — 925
lines handling registration, walking the queue, heartbeats, per-test timeouts,
retry and reload, profiling — and drives the client process over stdin/stdout,
handing it one test at a time. The MQTT protocol stays implemented once, in one
language. In `mqtt` mode the client speaks MQTT itself, which costs a port of
that state machine and an MQTT dependency in that language; it is declared in
the config shape now and implemented only when some client genuinely needs to
run without Node on the machine. The catalog and the interpreter are identical
either way — the transport is a flag, not an architecture.

Two things the framework already does make bridge mode cheap. The platform label
a consumer registers with is a free-form string, so `desktop-python` needs no
framework change to appear in reports and skip rules. And the memory sampler
already accepts the process id to watch and sums resident memory across that
process's tree, so pointing it at the client process covers the client and the
worker it started.

That second one carries a precondition worth stating, because it is not
universal: the worker has to be a descendant of the process being watched. It is
for Python today — the client spawns the Bare worker directly as a child and has
no path that attaches to a pre-existing one — but a future client that
re-parents the worker or connects to a shared one would silently under-count. So
this is a per-client check rather than a free property, and a client that cannot
satisfy it reports memory as not collected rather than reporting a number that
looks comparable and is not.

One thing matters more than any of it: every client must be pointed at the same
worker build, via the `QVAC_WORKER_PATH` environment variable that both the JS
and Python clients honour. The e2e suite does not use a stock worker — it
bundles its own with a specific plugin set, including a test-only plugin. With
both clients on that same binary the engine is identical by construction, so any
difference in the result can only have come from the client. Without it, the
comparison means nothing.

### Implementation phases (suggested)

- **Phase 1 — one category, end to end, on Python, locally.** A vertical slice
  rather than a layer: the minimum step interpreter, the few named assertions
  `embedding` needs, a bridged external consumer, a Python-side interpreter and
  resource table — and `embedding`'s 12 tests running green under
  `run:local:python`. Deliberately not polished and not in CI. The point is to
  learn from a real run before the vocabulary, the resource table format or the
  bridge protocol are committed to, and to find out early what a real client
  trips over. Phase 1 also records the value each test asserts on, not just its
  verdict, so cross-client comparison has a baseline from the first migrated
  category rather than from whenever a second client goes green.
- **Phase 2 — the same category on JS, plus suite tagging.** JS interprets the
  same 12 definitions and must reproduce what its executors produced. This is
  what makes JS the reference and every later migration self-checking. Tagging
  starts here too, because it is judgement and wants doing while the set is
  small. The vocabulary freezes at the end of this phase, which is when the
  schema and the implementer spec get written — both describe what two runs on
  two languages have already proven, rather than a guess.
- **Phase 3 — platform policy into data.** Skips with their reasons, the shared
  resource table with asset placeholders and per-platform overrides, the
  per-platform manager knobs. Gated on reproducing what each of the five legs
  runs today.
- **Phase 4 — widen the catalog.** The remaining categories, one at a time, each
  behind the JS legs. Modular by then: a category is a set of definitions plus
  whatever named assertions it needs. The missing Python wrappers close in
  parallel because they gate a fifth of the catalog.
- **Phase 5 — imperative tests and further clients.** The 37 hand-written tests
  per client as they are needed; further clients are config entries plus an
  interpreter.

The ordering is deliberate: the expensive, hard-to-reverse decisions — the step
vocabulary, the platform vocabulary, the resource table format — are all made
after something has actually run on a second language, not before. The honest
milestone after Phase 4 is 87 of the 107 smoke tests on Python, not 100, until
the aggregation wrappers land.

Two checkable conditions make the risky steps falsifiable rather than a matter
of judgement.

- A migrated test must produce, on the JS legs, the same result its TypeScript
  executor produced — otherwise it is not migrated.
- Moving platform policy into the catalog must not change what any leg runs. The
  counts in the table above (513 / 453 / 454 / 381 / 369) come from statically
  transcribing today's matchers, so Phase 3 starts by recording the real counts
  from a run of all five legs, and then requires them to be identical
  afterwards. A discrepancy of even one test means a rule was transcribed wrong.

### The measurement behind "477 of 514"

All 514 definitions were classified by the shape of their executor body. Counts
come from the built catalog (`dist/tests/test-definitions.js`); the shape
assignment comes from reading the executors, in full for a sample across
categories and by handler surface for the rest. The classification script can be
attached so reviewers can re-run and challenge it.

| Shape of the test body | Tests | Share |
| --- | ---: | ---: |
| Load the model the test declares → one SDK call → pull a field out of the result → check it against the expectation | 338 | 66% |
| Same, plus one reusable check that is more than a string or type comparison | 139 | 27% |
| Genuinely imperative: concurrency, cancellation races, process and OS inspection, local HTTP fixtures | 37 | 7% |

338 plus 139 is 477 of 514 — the same template repeated by hand. Of the 37
imperative ones, only 7 are in the `smoke` suite — the 107-test subset a PR runs
under the `test-e2e-smoke` label, as opposed to the full catalog under
`test-e2e-full`.

Model output is not deterministic, so most expectations correctly assert only
that a result of the right kind came back — 283 of the 514 check for a string or
an array and nothing beyond it. That is the right assertion for generated text,
but it means the expectation is not what will catch a client diverging: two
clients can both return a string and disagree about what they built from the
same stream. What catches that is comparing the clients against each other on
structure — element counts, vector length, event order, error codes — none of
which needs the model to be deterministic. So the migration records the value
each test asserted on, from the first category onward, which is what makes that
comparison possible later.

Two enabling facts. Dropping the JavaScript-function expectations, all 514
definitions survive a JSON round-trip without loss — the definition files import
types and nothing else, so the catalog is already data. And "load the model the
test declares" is already language-neutral: a test's metadata names a resource
key such as `llm` or `ocr`, and the consumer maps that key to a model plus its
load configuration. The one missing piece is how to get from params to the value
that gets asserted, which today exists only as TypeScript.

### What stays outside the suite-tag system

Two things stay outside the tag system because they are not properties of a
test: platforms a client does not ship to, which is the platform skip policy
above, and profiler output, which is a JS-side capability Python deliberately
does not mirror.

### The four further alternatives

- **Bridge each client into the JS consumer, keeping TypeScript executors.**
  Rejected for the same reason as the per-language port: only the protocol is
  shared, the test bodies are still written per language.
- **Cucumber or another Gherkin-style shared syntax.** One spec language, a
  client per language, implement a step once and reuse it. Rejected: it replaces
  our test structure rather than extending it, and our framework tooling would
  have to be rebuilt around it. Worth noting that MongoDB reached for Gherkin
  first for this exact problem and abandoned it over adoption resistance across
  language teams, then built what is essentially the proposal here.
- **Rely on QIP-1's generation pattern alone.** Generating clients from the
  contract keeps method names, signatures and types in lock-step, and the SDK
  already fails CI when the two sides drift. Rejected as sufficient: it proves
  the surface, not the behaviour behind it. Folding a stream into a result,
  mapping an error onto a typed exception, the ordering guarantees of
  cancellation, the tool loop — all of it is hand-written per client by
  construction, and that is exactly where a release claim needs evidence.
- **Adopt an external multi-language SDK's synchronisation model**
  (Desert-Ant-Labs/desert-ant-core, raised on the task). The repository itself
  is not a template for us: from its public material it is three independently
  hand-written SDKs over different runtimes, synchronised by pinning a model
  revision per SDK version, with no cross-language conformance corpus visible.
  We have one worker and one contract, and what needs synchronising is client
  behaviour rather than model weights. The technique the suggestion points at —
  golden vectors holding ports in step — is real and is the golden-envelope
  alternative above; it is kept as a pre-filter rather than the mechanism.

### Consequences: the detail the core compresses

- The catalog will move once, from `packages/sdk/e2e/catalog/` to its own
  package when a second client is green.
- Producer runs stay single-consumer. The orchestrator hands the queue to the
  first registrant, so each client is its own run and its own CI leg, not a
  second participant in an existing run. A constraint the design accepts rather
  than changes.
- Python's matrix is capped until product work outside this QIP lands. The
  generated stubs exist for the whole RPC surface — that is QIP-1 phase 1, and
  it is done. What is missing is the ergonomic layer above them. QIP-1 describes
  a fold for text generation and does not mention equivalents for the other
  streaming methods, and today Python has none: `ocr_stream`,
  `diffusion_stream`, the two `world_*_stream` calls, `audio_gen_stream` and
  `batch_completion_stream` are raw generators the caller must assemble, TTS
  returns frames rather than assembled audio, and RAG is a single call over a
  nine-member request union instead of nine named operations. 112 of 514 tests
  assert against the assembled results the JS wrappers produce (tts 30, ocr 29,
  diffusion 23, rag 10, world 8, batch-completion 6, audiogen 6), so roughly 78%
  of the catalog is the ceiling for a Python claim until they land, and those
  112 read *incomplete*. Writing them in test code instead would make the tests
  assert against test code, so the proposal leaves them as product work and
  accepts the delay.

### Trust boundary

Unchanged. The catalog is in-repo test data, the framework's MQTT broker is
already how e2e runs, and the Python client's worker RPC is loopback-only,
matching the documented "Local Worker RPC — local IPC/loopback only; trusted
local process model" boundary. No new transport, storage or auth surface is
introduced, and no product code path changes.

### Compatibility / release impact

`@qvac/test-suite` changes are additive and warrant a minor release: `steps` is
optional, `consumers.external` is new, JSON catalog loading is new, the
named-assertion registry is new, `report:matrix` is new, and
`MemorySample.platform` widens to `string` (it already receives arbitrary
strings at runtime). Existing configs, commands, consumers and MQTT messages
keep working. The message schemas are non-strict Zod objects, so an older
consumer receiving a newer message simply drops fields it does not know; the
converse direction is safe as long as any field added to the wire is declared
optional, which the existing `filteredTestIds` field already establishes as the
pattern. `packages/sdk/e2e` changes are internal. `tetherto-qvac-sdk` gains
public wrappers and releases on its own cadence.

### Principles

This advances Principle 6 (Developer Experience is Architecture): a released
Python client whose behaviour is unproven against the reference client is a DX
defect the architecture is responsible for, not a documentation gap. It also
clarifies Principle 2 (Cross-Platform Parity) rather than conflicting with it:
parity is asserted per client distribution, and the matrix makes the non-covered
cells explicit instead of silent.

### :warning: Risks

- **A step vocabulary that turns out too narrow mid-migration.** Discovering a
  ninth required operation after 300 tests are migrated is expensive.
  - *Mitigation:* the vocabulary was read off existing executors rather than
    designed up front, and Phase 1 migrates a whole category before it is
    frozen. It has not been checked against all 60 — the composite-key case was
    already found that way and folded into `useModel`.
- **A skip rule transcribed wrong**, quietly changing coverage on a platform
  nobody is watching.
  - *Mitigation:* Phase 3 records what each of the five legs actually runs
    before the move and requires the same counts after; a one-test discrepancy
    fails the step.
- **A client silently under-claiming and looking green.** A thin implementation
  could pass by not claiming much.
  - *Mitigation:* *incomplete* is a distinct state with a required reason, and
    the matrix shows it next to *pass* — a shrinking claim is visible per
    release.
- **A client asserting less than the definition demands and still reporting
  pass.** This is the sharper version of the risk above and the one MongoDB
  actually hit: their Node drivers passed the shared tests while violating the
  spec, because the runner did not assert the contents of what came back
  rigorously enough. Two major releases went out before it was caught
  (documented in The Polyglot's Dilemma, linked above). Assertion depth, not
  test count, is what makes a shared catalog mean anything.
  - *Mitigation:* the named assertions are a shared contract with defined
    semantics rather than per-client judgement, and the cross-client value
    comparison is fed from Phase 1 onward, so it has something to compare as
    soon as a second client is green — comparing the asserted value between
    clients, not just the verdict, is the only thing that catches a shallow
    runner.
- **Python results diverging for transport reasons rather than client reasons.**
  The two clients do not share a socket family: `bare_rpc_transport.py` binds
  loopback TCP on every OS because asyncio has no cross-platform unix-socket
  server, while the Node client uses a unix domain socket or a named pipe.
  - *Mitigation:* both clients point at the same worker via `QVAC_WORKER_PATH`,
    so the engine is identical; transport-caused differences are reproduced
    against `tests/test_bare_rpc_transport.py` before being treated as client
    bugs.
- **Stalling at 78% on Python** because the missing wrappers are product work
  outside this QIP.
  - *Mitigation:* those 112 tests are tracked as *incomplete* cells rather than
    absent, so the gap is visible rather than assumed closed.

### :sparkles: Nice to haves

- **Golden envelope vectors as a pre-filter** — the rejected alternative above,
  run on a hosted runner in seconds before spending GPU time. Catches marshaling
  and stream-folding drift early.
- **Producer-side skip filtering.** Once skips are data, the producer can leave
  skipped tests out of the queue instead of dispatching them and receiving
  `skipped` back.
- **Cross-client value diffing.** Compare the asserted value between two clients
  for the same test, not just the verdict, so two clients cannot both pass on
  materially different results. The values it compares are captured from Phase 1
  onward, so by the time a second client is green there is already a baseline to
  diff against.
