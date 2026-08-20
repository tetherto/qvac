# QIP: Fabric-stack CI for parallel qvac-fabric development

*Status:* Draft — for team review
*Authors:* @juan.arias
*Created:* 2026-08-05

---

## People to consult before posting

• *Fabric / addon pod lead* (`packages/fabric`, `qvac-fabric-llm.cpp`) — overlay-port workflow and `@qvac/fabric` runtime contract
• *DevOps / CI* — workflow orchestration, merge-guard wiring, runner cost, fork-trust policy
• *Classification-ggml owners* — first `@qvac/fabric` npm consumer; validates overlay-local-fabric pattern
• *Direct vcpkg consumer owners* (llm, embed, ocr, nmt, vla) — path-filter and smoke-matrix coverage
• *Lead / Architect* — cross-package dependency model during migration

---

## Approvers

| Role | Approver | Status |
| --- | --- | --- |
| Lead / Architect | @Dima / @Yury Samarin | |
| Head of QVAC | @Marco | |
| CTO | @Mathias Buus | |

---

## :mag: Problem

`qvac-fabric` (forked llama.cpp + ggml) is developed in `qvac-fabric-llm.cpp`, published to `qvac-registry-vcpkg`, and consumed by QVAC inference addons in two ways:

*1. Direct vcpkg* — packages declare `qvac-fabric` in `vcpkg.json` and compile locally (`llm-llamacpp`, `embed-llamacpp`, `ocr-ggml`, `translation-nmtcpp`, `vla-ggml`, and `packages/fabric` itself).

*2. npm runtime* — migrated consumers depend on `@qvac/fabric`, which ships the shared `qvac__fabric.bare` prebuild plus headers/CMake config (`classification-ggml` today). All other fabric-consuming addons will follow this path; only `packages/fabric` keeps building `qvac-fabric` from vcpkg.

*What works today*

Parallel development already works for *direct vcpkg consumers*: a qvac PR can add a vcpkg overlay port pointing at a test branch in `qvac-fabric-llm.cpp`, and per-package `on-pr-*` workflows build and test those addons against the unreleased engine.

*The gap*

That flow does *not* cover npm-runtime consumers. Their CI runs `npm install`, which resolves the *published* `@qvac/fabric` from the registry — not the fabric prebuild produced from the overlay in the same PR. If a stack PR also changes consumer code to call a new symbol exposed by the test fabric, CI may compile against stale headers and pass or fail for the wrong reasons.

*What we need*

A single, automatic CI process that:

• Runs on PR open/sync (no manual dispatch)
• Validates both consumer families during the `@qvac/fabric` migration
• Supports combined changes: unreleased `qvac-fabric` + consumer addon code that depends on new APIs
• Does not require publishing `@qvac/fabric` to npm for stack validation

---

## :bulb: Solution

Introduce a *fabric-stack PR* convention and CI orchestration that treats `@qvac/fabric` prebuilds as the artifact bridge between unreleased `qvac-fabric` and npm-runtime consumers.

### PR author workflow

1. Develop `qvac-fabric` on a fork or test branch in `qvac-fabric-llm.cpp`.
2. Open a qvac PR that includes:
   • A vcpkg overlay port (`vcpkg-overlays/ports/qvac-fabric/`) referencing that branch/SHA
   • Updates to `packages/fabric` (and direct vcpkg consumers as needed)
   • Optional consumer addon changes that use new fabric APIs
3. Push — CI runs automatically.

### Architecture (two consumer families)

```
qvac-fabric (overlay → test branch)
        │
        ├─► packages/fabric  ──► @qvac/fabric prebuild artifact
        │                              │
        │                              ▼
        │                    npm-runtime consumers
        │                    (overlay into node_modules/@qvac/fabric)
        │
        └─► direct vcpkg consumers
            (build qvac-fabric from overlay at compile time;
             no npm overlay step)
```

*Fabric host* (`fabric`)
• Builds from overlay; produces the prebuild artifact

*Direct vcpkg* (`llm-llamacpp`, `embed-llamacpp`, `ocr-ggml`, `translation-nmtcpp`, `vla-ggml`)
• Checkout includes overlay; `bare-make` resolves vcpkg locally

*npm runtime* (`classification-ggml` — grows as addons migrate)
• `npm install` scaffold + *overlay-local-fabric* from fabric prebuild artifact

### CI orchestration

*1. Fabric-stack detection*

Set `fabric_stack=true` when the PR's own diff (merge base to head) touches a `packages/fabric` file that changes the built artifact:

• C/C++ sources and headers, `CMakeLists.txt`, `cmake/**`
• `vcpkg.json` or `vcpkg-configuration.json` — the only way a new `qvac-fabric` port revision, registry baseline, or overlay registration reaches the build
• `binding.js`, `exports.txt`, `symbols.map`

Docs, release notes and tests are excluded: they produce no prebuild for a consumer to wait on. `vcpkg-overlays/**` is excluded for the same reason as in the path filters below — the files alone activate nothing.

*2. Fabric-first prebuild*

Extend `on-pr-fabric` so stack PRs always:

1. Build `packages/fabric` with the overlay (existing `prebuilds-fabric.yml`)
2. Upload a merged `fabric-prebuilds` artifact (`prebuilds/` tree: platform binaries, `include/`, `share/qvac-fabric/`)

This artifact is the single source of truth for the test runtime in the PR.

*3. Direct vcpkg consumers*

• Existing per-package `on-pr-*.yml` path filters already cover stack PRs when the author updates each consumer's `vcpkg-configuration.json` (under `packages/<pkg>/**`) to register the overlay — do **not** add a separate `vcpkg-overlays/ports/qvac-fabric/**` filter; overlay files alone do not activate the port without that config change
• No npm overlay step; existing per-package prebuild + integration jobs continue
• Lockstep `version>=` via `verify-qvac-fabric-lockstep` (scans all `packages/*/vcpkg.json`)

*4. npm-runtime consumers — `overlay-local-fabric` action*

New reusable action (same pattern as co-load smoke in `test-android-sdk.yml`):

```
overlay-local-fabric
  inputs: fabric-artifact, consumer-dir

  1. npm install --ignore-scripts
  2. download fabric-prebuilds artifact
  3. copy into every node_modules/@qvac/fabric match:
       prebuilds/<platform>-<arch>/
       prebuilds/include/
       prebuilds/share/qvac-fabric/
  4. consumer bare-make generate && build
  5. consumer cpp-tests + integration-tests
```

*Critical ordering* for combined PRs (consumer code + new fabric API):

```
fabric-prebuild → overlay-local-fabric → consumer native build → tests
```

Headers for `find_package(qvac-fabric)` must come from the overlaid `node_modules/@qvac/fabric/prebuilds/` *before* `bare-make generate`.

*5. Orchestration entry point*

Extend `on-pr-fabric` as the stack orchestrator when `fabric_stack=true`:

• Run fabric prebuild (existing)
• Run `packages/fabric/test/integration` (`shared-runtime.test.js`) after prebuild
• Matrix over npm-runtime consumers from the manifest below
• Fold results into merge-guard via existing `public-pr.yml` boolean inputs

When a stack PR also touches `packages/classification-ggml/**`, `on-pr-classification-ggml` still runs — but prebuild/integration jobs `needs` fabric-prebuild (or downloads the same `fabric-prebuilds` artifact) when `fabric_stack=true`.

*6. Consumer manifest*

Add `.github/fabric-consumers.json`:

```json
{
  "npm_runtime": [
    "classification-ggml"
  ]
}
```

`npm_runtime` = packages that already depend on `@qvac/fabric`. It is the matrix for the consumer smoke job, so an addon joins the list as it migrates.

The complement — packages that still compile `qvac-fabric` themselves — is not enumerated here. It is derivable (`packages/*/vcpkg.json` still listing the port) and `verify-qvac-fabric-lockstep` already walks that set, so a second hand-maintained roster would only drift.

### Trust boundary

• Stack jobs use existing `pull_request_target` + fork-approval + SHA pin (`authorize-pr`, `fork-approval`)
• Overlay ports fetch `qvac-fabric` at a pinned git ref via vcpkg — same trust model as today; no remote script execution
• `overlay-local-fabric` only copies artifacts from the same workflow run

### Compatibility / release impact

• No public API change — CI and process only
• No breaking change for non-stack PRs; main-branch CI unchanged except improved path filters for overlay-only PRs
• Release path unchanged: merge fabric → publish `qvac-fabric` → coordinated bump PR → publish `@qvac/fabric` npm. Stack CI is pre-merge validation, not a new release channel.

---

## :twisted_rightwards_arrows: Alternatives considered

*Publish dev versions to `qvac-registry-vcpkg`* (e.g. `9840.2.0-dev.<sha>`)
Avoids overlay machinery but pollutes the registry and still does not solve npm `@qvac/fabric` without a separate dev npm publish.

*npm `file:../fabric` in consumer `package.json` for stack PRs*
Requires every stack PR to edit consumer manifests; conflicts with lockfile hygiene and is easy to merge accidentally.

*Cross-repo trigger from `qvac-fabric-llm.cpp`*
Couples fabric repo to qvac CI; qvac should own the test harness, fabric repo supplies only the git ref via overlay.

*New standalone `on-pr-fabric-stack.yml` only*
Viable, but duplicates wiring already in `on-pr-fabric`; extending the existing workflow keeps one entry point.

*Full consumer matrix on every fabric PR*
Too expensive; tier smoke on fabric PR, full matrix on `verify` label or version-bump PRs.

---

## :scales: Consequences

*Positive impact*

• Parallel `qvac-fabric` + addon development is CI-proven before merge, including npm-runtime consumers
• One documented PR shape for fabric changes; less reliance on ad-hoc overlay skills and manual Device Farm runs for compile/link regressions
• Migration-safe: both paths exercised without forcing premature consumer migration
• Reuses proven patterns: co-load prebuild overlay, fabric `shared-runtime` integration test, existing per-addon workflows

*Trade-offs reviewers must accept*

*Extra CI time on fabric-stack PRs*
Fabric prebuild already runs; npm consumer matrix is small today. Mitigation: tier expensive mobile/Device Farm behind `verify` label.

*Operational complexity*
Overlay port maintenance, manifest file, new composite action. Mitigation: author checklist in `packages/fabric/INTEGRATION.md`.

*Duplicate workflow runs* when PR touches both `packages/fabric` and `packages/classification-ggml`
Mitigation: coordinate via `needs: fabric-prebuild` and shared artifact name.

*Prebuild reuse cache* may serve stale fabric when only overlay REF changes
Mitigation: include overlay REF in `detect-native-changes` hash or disable reuse for `fabric_stack` PRs.

*Mobile tests a PR-built addon against the published fabric runtime*
The overlay reaches every prebuild matrix entry, mobile included, so the Android/iOS
`.bare` modules are compiled and linked against PR fabric. The ggml runtime is not
bundled by the addon (`qvac_addon_use_fabric`), so the libraries packed into the
APK/IPA are whatever `npm install` resolves for `@qvac/fabric` — the published
release. Mobile therefore exercises a mismatched pairing rather than either a clean
PR stack or a clean published baseline, and an ABI-breaking fabric change can crash
on device or pass for the wrong reason. Closing it means overlaying fabric inside
`.github/actions/run-mobile-integration-tests/build-mobile-app` between the
test-framework `npm install` and the app build; that composite is shared by 14
mobile workflows and the overlaid tree has to land where the external
`tetherto/qvac-test-addon-mobile` bundler looks, so it needs its own change with a
real fabric-stack mobile run to validate. Bounded for now: the mobile job is
`continue-on-error: true` and runs only behind the `mobile` label.

*New responsibilities*

• Fabric-stack PR authors keep overlay REF in sync with the `qvac-fabric-llm.cpp` branch under test
• DevOps maintains `.github/fabric-consumers.json` as consumers migrate
• Merge order: fabric engine merged and published before consumer releases that depend on new symbols (process, not enforced by CI)

---

## :no_entry_sign: Out of scope

• Automating registry publish or coordinated bump PRs after `qvac-fabric` release
• Replacing `/vlm-benchmark` or Device Farm performance A/B — stack CI targets correctness (compile, link, integration smoke), not perf gates
• Migrating remaining direct vcpkg consumers to `@qvac/fabric` — separate work in `INTEGRATION.md`
• Mobile fabric-stack overlay — desktop smoke first; see the mismatched-runtime trade-off above

---

## :sparkles: Nice to haves

• Domain-aware consumer selection from `qvac-fabric-llm.cpp` diff (e.g. vision changes → auto-include `ocr-ggml`)
• `workflow_dispatch` input `qvac_fabric_ref` for re-running stack CI without a new commit
• Script `scripts/fabric/bump-consumers.mjs` for coordinated `version>=` updates at release time
• Run `packages/fabric/test/integration` with llm + embed on stack PRs as a migration canary

---

## Implementation phases (suggested)

*Phase 1* — `.github/fabric-consumers.json` + author docs in `INTEGRATION.md`
Shared vocabulary

*Phase 2* — `overlay-local-fabric` composite action
npm consumers use PR fabric

*Phase 3* — Extend `on-pr-fabric`: detection, npm-consumer matrix, `shared-runtime` test
Auto validation on PR open

*Phase 4* — Confirm direct consumer `on-pr-*` workflows trigger via `packages/<pkg>/vcpkg-configuration.json` updates (no overlay-only path filter)
Overlay-only PRs without config changes do not run consumer CI

*Phase 5* — `needs: fabric-prebuild` in `on-pr-classification-ggml` when `fabric_stack`
Combined fabric + consumer code changes

---

## Author checklist

☐ Problem is clear and timely
☐ Solution is concrete enough to review
☐ Chosen solution is justified against obvious alternatives
☐ Trust boundaries and security properties are explicit when affected
☐ Compatibility, migration, and release impact are explicit when affected
☐ Alternatives considered is brief
☐ Consequences state positive impact and trade-offs reviewers must accept
☐ Out of scope is explicit
☐ Approvers table preserved
☐ Consultation note reflects affected teams and expertise
