# Suite tags: what a non-JS leg may leave out

A client that is not the reference JS client does not have to run everything.
What it may leave out is expressed as **tags on the definition**, not as prose
in a README and not as a list in CI — so the decision is reviewable in a diff
and the producer can act on it with machinery that already exists
(`--suite` / `--exclude-suite`).

Deciding which test deserves which tag is the hardest judgement in this whole
proposal, and these four are a starting shape rather than a finished taxonomy.
Tagging starts while the migrated set is small precisely so the judgement is
made on tens of tests rather than hundreds.

> A tag says "this leg may skip it", never "this test is unimportant". Every
> tagged test still runs on the JS legs.

---

## `engine-quality`

**The assertion is about the model's output, not the client's behaviour.**

The worker is the same binary for every client, so output quality is proven
once, on the JS legs. A non-JS run asserts that the client drives the worker
correctly — not that the model is good.

Tag it when the test would still be meaningful if you swapped the client but
would become meaningless if you swapped the model.

*Not* `engine-quality*: a test that asserts a vector has 1024 elements, or that
a stream produced blocks in order. Those are claims about what the client
assembled.

## `packaging`

**The test is about how the JS SDK is distributed.**

Electron Forge, asar, our own Forge plugin, strict Snap confinement, the
graphics content interface. No generated client has such a distribution, so
there is nothing there for it to test.

Currently tagged: `snap-storage-common-root`.

## `imperative`

**The body cannot become data.**

Concurrency, cancellation ordering, process and OS inspection, local HTTP
fixtures. These are exactly where language runtimes differ, so a hand-written
body per client is the right answer rather than a failure of the design — but
until a client writes one, the test reads `incomplete` for that client, with
an owner.

Currently tagged: the `cancel-*` family, `serialize-concurrent-completion` and
`no-lingering-bare-*` (14 tests).

## `host-idiomatic`

**Behaviour a client is expected to express in its own idiom rather than
mirror.**

Python using stdlib `logging` instead of `getLogger`, its notebook facade, and
similar. Each such divergence is already listed in that client's README and
covered by its own tests, so mirroring the JS shape would be testing the wrong
thing.

---

## What is deliberately *not* a tag

Two things are not properties of a test and must not become tags:

- **Platforms a client does not ship to.** That is the platform skip policy,
  which lives in `skip.platforms` with a reason attached.
- **Profiler output.** A JS-side capability Python deliberately does not
  mirror; it is a capability gap, not a test category.

---

## Using them

```bash
# What a Python leg runs today: everything except what it may leave out.
qvac-test run:local:python --exclude-suite=imperative,packaging,engine-quality,host-idiomatic
```

An excluded test is reported `skipped` with its reason, not silently dropped —
so the claim matrix still has a row for it on every client.
