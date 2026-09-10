# QVAC Test Suite v0.12.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.12.0

One new selection option. `run:producer` can now add named tests on top of whatever a suite already selected — a combination the existing options could not express.

---

## New APIs

### Add specific tests on top of a suite with `--include`

`--suite`, `--exclude-suite` and `--filter` all compose with AND: each one narrows what the previous left. That makes "run this suite, plus these particular tests" impossible to ask for. `--suite=smoke --filter=parakeet` returns the intersection — the handful of parakeet tests that happen to be tagged smoke — when what was wanted was the union.

`--include` takes a comma-separated list of test ids and unions them back in after the other options have had their say:

```bash
# Before — the intersection, a few tests at best and often none.
qvac-test run:producer --suite=smoke --filter=parakeet

# After — the whole smoke suite plus these three, whatever their tags.
qvac-test run:producer --suite=smoke \
  --include=parakeet-tdt-mp3,parakeet-ctc-wav,parakeet-unified-mp3
```

Three behaviours are worth knowing.

It matches **exact ids, not prefixes**. This is the opposite of `--filter`, where `model-load-llm` also drags in `model-load-llm-load-mode-none`. With `--include` an id selects that test and nothing else, so adding one case to a suite run cannot quietly pull in its neighbours.

An id that matches nothing **fails the run**. Naming a test and then getting a green run that never executed it is the opposite of what was meant, so the mistake surfaces immediately instead of being silently dropped.

An empty value is a **no-op**. Callers — CI templates in particular — can pass the flag unconditionally without special-casing the empty case.

`run:local:*` forwards the option too, so the same selection works when driving a run locally.

Internally the selection rules moved out of the producer command into a pure `selectTests()` helper, so suite, exclude, filter and include compose in one place rather than being spread across the command.
