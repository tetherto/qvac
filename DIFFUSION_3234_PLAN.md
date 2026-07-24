# Harden Diffusion Model Provenance and Cache Performance (PR #3234)

Tracking: QVAC-21937 · Branch: `feature-qvac-21937-diffusion-model-integrity-pins`

Supersedes the earlier "Diffusion Cache Proof" plan. This version narrows the
cache work to exactly what the reviewer asked for and anchors every decision on
empirical evidence.

## Reviewer blockers (both on #3234)

1. **Q4 provenance mismatch.** Runtime SHA of `stable-diffusion-v2-1-Q4_0.gguf`
   is `27740067…`; immutable HF metadata identifies `3bc6163b…`. `sourceSha256`
   only documents the mismatch. Reviewer requires a source whose delivered bytes
   match its immutable content address, or the canonical object — not an
   exception.
2. **Warm-cache hashing too slow.** Exact cache hits still full-hash ~48.5 GB
   per runner (44–50 min) with zero downloads. Reviewer wants a safe verified
   marker fast path plus an end-to-end warm run proving it skips full rehashing
   without weakening integrity.

## Empirical findings (verified 2026-07-14)

- Fresh `resolve/main` download of the Q4 file → SHA `27740067…`, size
  2185459424. HF's redirect object path **and** `X-Linked-ETag` both say
  `3bc6163b…`. It is served over **legacy LFS** (`cdn-lfs-us-1.hf.co`) where the
  stored blob does not match its own pointer OID. **The canonical `3bc616…`
  object is not retrievable** — the reviewer's "pin the canonical object" option
  is impossible from this source, and `sourceSha256` is documenting broken bytes.
- `stable-diffusion-v2-1-Q8_0.gguf` (the replacement) and
  `stable-diffusion-xl-base-1.0-Q4_0.gguf` (retains Q4-format coverage) are both
  served over **Xet** (`cas-bridge.xethub.hf.co`); their `X-Linked-ETag` matches
  the committed SHA pins exactly. They are trustworthy.
- Runtime `verifyModelFileOnce()` in `packages/diffusion-cpp/test/integration/utils.js`
  already does an **unconditional, authoritative SHA-256** of every model at
  first use. The warm-step hash on an *exact hit* is therefore redundant. This is
  the key integrity argument: the marker only removes a duplicate read pass; it
  can never let corrupted bytes reach inference because `ensureModel` still
  hashes before any model loads.

## Engineering decisions

- Treat `stable-diffusion-v2-1-Q4_0.gguf` as a broken test fixture, not a product
  contract. Remove it and repoint its 3 generic consumers to the already-pinned,
  Xet-backed `stable-diffusion-v2-1-Q8_0.gguf`. Delete the exception machinery so
  every HF artifact again satisfies `downloaded SHA/size == canonical content
  address`. Q4-format coverage stays via SDXL Q4_0. Do not touch the SDK model
  registry.
- Keep the cache change **minimal and inside `warm-models.mjs` + small action
  wiring**. No new opt-in action input, no prerequisite prep matrix jobs, no
  restore/save-branch redesign. The existing post-job save persists the marker.
  The marker fast path only ever skips a redundant hash; runtime `ensureModel`
  remains the authoritative first-use SHA check.
- One deliberate `cache-version` bump for diffusion (reason: `restore-keys`
  prefix matching would otherwise restore the old Q4-bearing archive on the
  transition run). The manifest-hash change re-keys automatically; do not also
  churn `cacheEpoch` and a third "new cache version" — a single bump is enough.
- QIP triage: localized CI cache/integrity maintenance; no architectural
  significance trigger applies.

## Part A — Provenance (resolve blocker 1)

1. Repoint the 3 real consumers from `stable-diffusion-v2-1-Q4_0` to
   `stable-diffusion-v2-1-Q8_0`, and fix perf labels (`Q4_0` → `Q8_0`):
   - `packages/diffusion-cpp/test/integration/api-behavior.test.js`
   - `packages/diffusion-cpp/test/integration/generate-image-esrgan-upscale.test.js`
   - `packages/diffusion-cpp/test/integration/main-gpu-backend.test.js`
   - Note: `input-validation.test.js` uses `/tmp/…Q4_0.gguf` **literal** paths for
     negative tests — no manifest dependency; leave as-is but call this out in the
     PR so it doesn't read as a stray Q4 reference.
2. Delete the `stable-diffusion-v2-1-Q4_0` entry from
   `packages/diffusion-cpp/test/integration/models.manifest.json` (base group
   drops 14 → 13).
3. Remove `sourceSha256`/`sourceBytes` exception handling from
   `packages/diffusion-cpp/scripts/generate-model-manifest.mjs` (~lines 221–247)
   so every HF artifact must satisfy `downloaded SHA/size == canonical LFS/Xet
   content address`.
4. Update tests/docs that currently assert the exception/known-mismatch exists:
   - `packages/diffusion-cpp/scripts/generate-model-manifest.test.mjs`
   - `packages/diffusion-cpp/test/unit/ensure-model-integrity.test.js`
     (the "known mismatch" assertions around the Q4 entry)
   - `packages/diffusion-cpp/test/integration/MODELS_MANIFEST.md`
5. Bump the diffusion `cache-version` once in
   `.github/workflows/integration-test-diffusion-cpp.yml` (documented reason:
   evict the Q4-bearing archive so `restore-keys` can't carry it forward).

## Part B — Cache fast path (resolve blocker 2)

Scope: `.github/actions/cache-models/warm-models.mjs` + minimal `action.yml`
wiring. No new action input, no prep jobs.

6. After every selected file in a group passes full SHA/size verification, write
   a marker atomically (e.g. `packages/diffusion-cpp/test/model/.qvac-verified-<group>.json`)
   recording: package, group, exact primary cache key, manifest digest, model
   count, and each selected model's `{name, sha256, bytes}`.
7. Add an `--exact-hit` flag to `warm-models.mjs`; the action passes the
   exact-key hit signal through (`steps.cache.outputs.cache-hit` /
   `steps.cache-restore-only.outputs.cache-hit`). Fast path (skip hashing) fires
   **only** when ALL hold:
   - exact-key hit (not a `restore-keys` prefix restore),
   - marker present + parseable + co-restored,
   - every identity field matches (package, group, cache key, manifest digest,
     model count, per-model sha/bytes),
   - every selected file exists with the expected **size** (cheap stat).
   Any failure (prefix restore, missing/stale marker, count/hash/size mismatch,
   unpinned entry) → full SHA verification.
8. Include the marker path in the group's `--paths-output` so it is archived and
   restored with the group.
9. Emit structured outputs/logs: `verification-mode` (`marker-skip` vs `full`),
   hashed count, downloaded count, verified count — so the PR proves behavior
   rather than inferring it from wall-clock time.

## Part C — Automated tests (extend, never weaken)

- Expand `.github/actions/cache-models/test/warm-models.test.mjs`:
  - cold/prefix restore → hashes files and writes a marker;
  - valid exact hit → zero warm-step hashes and zero downloads;
  - missing file / wrong size / missing-or-stale marker / manifest-key-group
    mismatch / unpinned entry → cannot use fast path (full verification);
  - per-group marker paths are isolated and included in cache paths.
- Run: `generate-model-manifest.test.mjs`, cache-action tests, diffusion unit
  suite, package lint/format, and `actionlint` on the workflow. Do not skip or
  weaken any existing test.

## Part D — End-to-end proof (for PR #3234 evidence)

1. Dispatch pin generation for Q8 from a clean runner; canonical Xet
   `X-Linked-ETag` must equal the fresh download and match the committed pin.
2. Cold run on the bumped cache-version: groups show cold misses, full
   verification/downloads, marker creation, and post-job saves; inspect all
   **7/7** desktop platform job conclusions individually (`continue-on-error` is
   on).
3. Warm re-run on the same ref: every group is an exact hit reporting
   `marker-skip`, zero warm hashes, zero downloads, and materially shorter cache
   steps.
4. Current-head Android + iOS diffusion validation (Q8 now backs the API-behavior
   tests); both must pass.
5. Update PR #3234 body + evidence comment with: commit SHA, the Xet-vs-legacy-LFS
   root cause, provenance artifact URL, cold and warm run URLs, per-group
   counters/timings, 7/7 desktop results, Android/iOS results, and an explicit
   statement that the Q4 fixture was removed because its upstream content address
   is unrecoverable.

## Blast radius

`warm-models.mjs`, a few lines of `action.yml` wiring, the diffusion workflow's
`cache-version`, and diffusion test/manifest/doc files. No behavior change for
LLM, embed, or other `cache-models` callers.

## Execution notes

- Drive implementation with Opus subagents (Part A provenance; Part B/C marker +
  tests). Do not switch to Composer.
- Merge order unchanged: **#3196 → #3195 → #3234**; rebase #3234 after #3195
  since both edit `.github/actions/cache-models`.
