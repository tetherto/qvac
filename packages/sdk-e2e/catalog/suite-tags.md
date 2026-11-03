# Suite tags: what a non-JS leg may leave out

A client that is not the reference JS client does not have to run everything.
What it may leave out is expressed as **tags on the definition**, not as prose
in a README and not as a list in CI — so the decision is reviewable in a diff
and the producer can act on it with machinery that already exists
(`--suite` / `--exclude-suite`).

Deciding which test deserves which tag is the hardest judgement here. Two of
the four tags are in use; the other two are defined but carry nothing yet.

> A tag says "this leg may skip it", never "this test is unimportant". Every
> tagged test still runs on the JS legs.

---

## `engine-quality`

**The assertion is about the model's output, not the client's behaviour.**

The worker is the same binary for every client, so output quality is proven
once, on the JS legs. A non-JS run asserts that the client drives the worker
correctly — not that the model is good.

Tag it when the test would still be meaningful if you swapped the client but
would become meaningless if you swapped the model. _Not_ a test that asserts a
vector has 1024 elements: that is a claim about what the client assembled.

Nothing carries this tag yet.

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

Currently tagged: the cancellation tests and the `no-lingering-bare-*` tests.

## `host-idiomatic`

**Behaviour a client is expected to express in its own idiom rather than
mirror.**

Python using stdlib `logging` instead of `getLogger`, its notebook facade, and
similar. Each divergence is listed in that client's README and covered by its
own tests, so mirroring the JS shape would be testing the wrong thing.

Nothing carries this tag yet.

---

## What is deliberately _not_ a tag

Two things are not properties of a test and must not become tags:

- **Platforms a client does not ship to.** That is the platform skip policy,
  which lives in `skip.platforms` with a reason attached.
- **Profiler output.** A JS-side capability Python deliberately does not
  mirror; it is a capability gap, not a test category.

---

## Using them

```bash
qvac-test run:local:python --exclude-suite=imperative,packaging
```

An excluded test is reported `skipped` with its reason, not silently dropped —
so the claim matrix still has a row for it on every client.

A leg may also run everything and let each unimplemented test report
`incomplete`, which is what the Python leg does today: it says more than a
skip, since the reason names what the client is missing.
