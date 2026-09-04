*QIP: Split `@qvac/fabric` into per-platform npm packages*

*Status:* Draft — for team review
*Authors:* @juan.arias
*Created:* 2026-09-01

---

*People to consult before posting*

• *Fabric / addon pod lead* (`packages/fabric`, `qvac-fabric-llm.cpp`) — shared runtime contract, backend layout, symbol/SONAME stability
• *DevOps / CI* — multi-package publish, `on-merge-fabric`, `overlay-local-fabric`, prebuild artifact slicing
• *npm-runtime consumer owners* (`classification-ggml`, `vla-ggml`) — `require.resolve('@qvac/fabric/package')`, CMake `qvac-fabric_DIR`, `resolveBackendsDir()`
• *Mobile / test-framework owners* — worklet packing, `mobile:copy-prebuilds`, Expo/npm optional-dep behaviour
• *Lead / Architect* — package boundary, install contract, CUDA/HIP as a second split axis
• *cmake-bare / Holepunch* — `#binding` imports map; reference [bare-collabora](https://github.com/holepunchto/bare-collabora/blob/82567e08897e44b5ff691e02fa06ebad23a35e7b/package.json#L13-L41)

---

:clipboard: *Approvers*

The following approvers are required in priority order:

• *Lead / Architect* — @Dima / @Yury Samarin —
• *Head of QVAC* — @Marco —
• *CTO* — @Mathias Buus —

---

:mag: *Problem*

`@qvac/fabric` is published as one npm tarball that contains every prebuild in the matrix: `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `win32-x64`, `android-arm64`, `ios-arm64`, plus iOS simulator flavours and Android arch copies. linux-x64 also ships the ROCm/HIP DL backend (`libqvac-ggml-hip.so`). Headers and CMake config ride in the same tarball.

Measured on the public registry: *`@qvac/fabric@0.9.0` unpacks to 622 MB* (233 files). Other fat addons are in the same band (`@qvac/llm-llamacpp@0.48.0` 549 MB, `@qvac/vla-ggml@0.23.0` 524 MB). `@qvac/asr-ggml@0.4.1` is already 330 MB _with_ a linux-x64 CUDA module in-tree.

That is a publish and install problem, not only a disk-on-device problem:

• Every `npm install` of a fabric consumer downloads Windows, macOS, iOS, and Android binaries onto a Linux builder, and the reverse on a phone.
• The npm registry has no comfortably documented hard cap, but publishes in this size class fail in practice (`413 Payload Too Large`, CLI timeouts, memory blow-ups). Native binaries compress poorly, so packed size stays a large fraction of the 622 MB unpacked tree.
• The next planned increment is a CUDA ggml backend. `prebuilds-fabric.yml` does not pass `include-cuda` today; ASR/TTS/audiogen already do, and the CUDA module is a large extra `.so` (multi-arch cubins). Adding it to the current single tarball is the near-term path to an unpublishable package.

*Why now:* CUDA is the size cliff. HIP is already in the linux-x64 prebuild. Waiting until publish fails forces an emergency packaging change under release pressure.

*What we need:* a packaging contract where a host downloads only the fabric runtime it can load, while consumers still depend on one name (`@qvac/fabric`), and we can add CUDA without putting the default tarball over the registry limit.

---

:bulb: *Solution*

Publish `@qvac/fabric` as a *meta package* plus *per-platform binary packages* selected by npm `optionalDependencies` + `os` / `cpu` (and `libc` on Linux). One git source tree (`packages/fabric`); platform packages are *sliced at publish time* from the existing merged `prebuilds/` artifact. Do not add per-platform source packages to the monorepo.

*Package graph*

```
consumer addon
  └── @qvac/fabric                    meta: binding.js, headers, CMake
        optionalDependencies (os/cpu filtered)
          ├── @qvac/fabric-linux-x64
          ├── @qvac/fabric-linux-arm64
          ├── @qvac/fabric-darwin-arm64
          ├── @qvac/fabric-darwin-x64
          ├── @qvac/fabric-win32-x64
          ├── @qvac/fabric-android-arm64
          └── @qvac/fabric-ios         (device + simulator flavours)
```

`os` / `cpu` on each binary package is what makes the installer skip the rest. Yarn classic (v1) ignores that filter and fetches every optional dep — supported installers are npm 7+, pnpm, bun, and Yarn Berry.

*Layout and load contract*

Meta package keeps:

• `binding.js` / `require('@qvac/fabric')`
• `prebuilds/include/` and `prebuilds/share/qvac-fabric/` (headers + `find_package`)
• a CMake helper that locates the *installed host platform package* for `include_bare_module(... PREBUILD)`

Each platform package keeps the current on-disk shape for one host: `prebuilds/<platform>-<arch>/qvac__fabric.bare` plus DL backends under `qvac__fabric/`.

Load follows the same pattern as Holepunch's [bare-collabora](https://github.com/holepunchto/bare-collabora/blob/82567e08897e44b5ff691e02fa06ebad23a35e7b/package.json#L13-L41): `binding.js` is `require('#binding')`, and `package.json` `"imports"` maps `#binding` to the host optional package using Bare's platform / arch / simulator conditions. `bare-pack --host` resolves that map for the *target* host; a JS `if (process.platform)` switch would follow the packer host or every branch. Dynamic `require('@qvac/fabric-' + name)` is still forbidden (tree-shaken away). We keep Android grouped in `@qvac/fabric-android-arm64` and iOS (device + simulator) in `@qvac/fabric-ios` rather than collabora's per-flavour packages, because our publish tree already fans those copies out and we are not adding `npm/*` workspaces to the monorepo.

Do *not* use a `postinstall` hoist into `node_modules/@qvac/fabric/prebuilds/<host>/`. Fabric-stack CI and several consumer jobs run `npm install --ignore-scripts` (`overlay-local-fabric`). Resolution has to work with scripts disabled.

`resolveBackendsDir()` today does `require.resolve('@qvac/fabric/package')` then looks for `prebuilds/`. After the split that path only has headers. Consumers switch to a helper exported by the meta package (or resolve the platform package). Mobile keeps the existing fallback: packed worklets cannot see `node_modules`, so the packager still flattens the *host* fabric prebuild into the addon’s own `prebuilds/` — it just copies from the android/ios platform package instead of from a fat meta tarball.

Missing platform package at runtime is a hard error with an actionable message (package name, expected `os`/`cpu`, “optional dep omitted or unsupported package manager”). Silent fallback to a half-installed tree is how optionalDependencies fail in the wild.

*CUDA / HIP: a second axis*

`optionalDependencies` + `os`/`cpu` cannot distinguish NVIDIA vs AMD vs CPU-only; all three are `linux` + `x64`. If CUDA is packed into `@qvac/fabric-linux-x64`, every linux-x64 install still pays for it — the platform split does not solve the CUDA size problem, it only stops phones from downloading it.

Follow the ASR pattern at the _file_ level (CUDA as a `GGML_BACKEND_DL` `.so` that is skipped when `libcuda` / cudart are missing) but *do not ship that `.so` in the default linux-x64 package*.

Phase 1 (this QIP): platform split; linux-x64 keeps today’s Vulkan (+ HIP, already shipped).
Phase 2 (same design, separate approval if needed): `@qvac/fabric-linux-x64-cuda` and `@qvac/fabric-linux-x64-hip` as *opt-in dependencies*, not auto-installed optionalDeps. Apps that want them declare them; `ggml_backend_load_all_from_path` gains the extra directory from the meta helper. HIP can move out of the base linux-x64 package in the same phase so CPU/NVIDIA hosts stop downloading gfx1151.

_Assumption:_ fabric CUDA will be linux-x64 first, matching `include-cuda` in `reusable-prebuilds.yml` and ASR. Windows CUDA would be a later `@qvac/fabric-win32-x64-cuda`.

*Publish and CI*

`on-merge-fabric` still builds the full matrix and merges the `prebuilds` artifact. The publish job then:

1. Publishes each platform (and later vendor) package at version *V*
2. Publishes the meta package at *V* last, so the name consumers depend on never appears without its binaries

No npm transaction exists; meta-last is the rollback. A failed platform publish fails the release rather than shipping a meta that optional-deps a missing tarball.

`overlay-local-fabric` overlays headers into the meta tree and the host binary into the matching platform package directory (the action already accepts `platform` + `arch`). Fabric-stack CI (`docs/architecture/qips/fabric-stack-ci.md`) stays valid; only the overlay destination and the consumer install shape change.

Versioning: all slices lockstep with the meta version. Consumer addons keep `"@qvac/fabric": "^x.y.z"`; they do not list platform packages unless they opt into CUDA/HIP.

*Trust boundary*

Unchanged at runtime: same `.bare`, same SONAME `qvac__fabric@0.bare`, same checksummed registry models. Supply chain grows by N provenance-attested npm packages on the same registry we already publish to. No extra download-and-execute path; binaries stay lockfile-pinned npm artifacts.

*Compatibility / release impact*

• `require('@qvac/fabric')` and the C API/SONAME stay the same.
• *Breaking for path-dependent consumers:* CMake `qvac-fabric_DIR` pointing at `node_modules/@qvac/fabric/prebuilds/share/...` can stay (headers remain in meta); `include_bare_module("@qvac/fabric" … PREBUILD)` and `resolveBackendsDir()` must follow the platform package. Coordinated bumps of `classification-ggml` and `vla-ggml` in the same release train.
• Installers that omit optional deps (`--omit=optional`) or Yarn v1 will not get a runtime. Document that.
• Semver: treat as breaking for the published file layout (`0.x` bump with `[bc]` in consumer changelogs, or `1.0.0` if we are ready to leave 0.x). Direct vcpkg consumers are unaffected.

---

:twisted_rightwards_arrows: *Alternatives considered*

*JS `if (process.platform)` / `require('@qvac/fabric-linux-x64')` switch*
A static specifier per host, but `bare-pack` either takes the packer's `process.platform` or follows every `require()`. Rejected in favour of collabora's `#binding` + `"imports"` conditions.

*OS-only packages (`@qvac/fabric-linux`, `-win32`, `-darwin`, `-android`)*
Matches the original sketch and cuts phone/desktop cross-downloads, but a single linux tarball would still carry x64+arm64 plus HIP and CUDA. Rejected as the published granularity; kept as the grouping story (iOS flavours may still share one `@qvac/fabric-ios` package).

*Keep one package, add CUDA as another DL `.so` inside it (ASR today)*
Correct runtime design (skip the module when the driver is missing) and wrong distribution design: the `.so` still sits in the tarball. ASR is already 330 MB; fabric is 622 MB before CUDA.

*Install-time download from GitHub Releases / a CDN*
Avoids the npm size cap and looks like `prebuild-install`. It makes `npm install` a network fetch of unsigned-at-lockfile bytes, breaks `--ignore-scripts` and offline CI, and fights Principle 1 (provisioning should be pinable, not a postinstall). Rejected.

*P2P / Hyperdrive for the `.bare` (treat binaries like models)*
Aligned with Principle 4, but it replaces “npm install gets you the runtime” — the contract every fabric consumer and `overlay-local-fabric` relies on. Far larger than a packaging QIP.

*Publish only to GitHub Packages*
GPR may accept larger tarballs; public npm is what SDK consumers and `latest` releases use. Does not remove the limit we actually hit.

*Strip / compress harder, drop simulator copies, don’t ship HIP*
Worth doing as hygiene (simulator flavours, Android arch copies) but does not create headroom for CUDA. HIP already has a runtime skip; the bytes still ship.

*Do nothing until publish fails*
The 622 MB unpacked package is already in the failure band; CUDA makes it a release blocker instead of a planned migration.

---

:scales: *Consequences*

*Positive impact*

• A linux-x64 or android-arm64 install no longer pays for the other seven prebuilds; Principle 9 (constrained devices) and Principle 3 (package boundaries from publish lifecycle) both support the split.
• CUDA can be added without blocking npm publish of the default runtime.
• Consumers still depend on one package name (Principle 6); platform packages are an install detail.
• Publish slicing reuses the current matrix; we do not rebuild fabric N times.

*Trade-offs reviewers must accept*

*N packages per release, lockstep versions, meta published last.*
Operational load on `on-merge-fabric` and release-merge-guard. Mitigation: generate platform `package.json` files in CI from one template; fail the release if any slice is missing.

*optionalDependencies failure mode is silent install + loud runtime.*
npm continues if a platform package 404s. Mitigation: meta `require()` fails with the expected package name; CI asserts the host slice is present after install.

*Package-manager coverage.*
Yarn v1 and `--omit=optional` will not work. Mitigation: document supported installers; do not add a postinstall downloader as a compatibility shim.

*Consumer path changes.*
`resolveBackendsDir()`, CMake PREBUILD, overlay-local-fabric, mobile flatten. Mitigation: helper in the meta package + coordinated consumer PRs; no postinstall.

*bare-pack / mobile worklets.*
Dynamic requires drop native code; packed worklets never see `node_modules`. Mitigation: `require('#binding')` plus the `"imports"` map (bare-collabora); keep mobile flatten, sourced from the platform package.

*Phase 1 does not stop linux-x64 from downloading HIP (or CUDA if we bundled it).*
Call that out so reviewers do not think the platform split finishes the CUDA story. Vendor extras are Phase 2.

*New responsibilities*

• Release publishes N+1 packages and verifies each tarball stays under an explicit size budget (CI `npm pack` + unpacked-size gate on meta and on each slice).
• Consumer authors use the meta helper instead of hardcoding `node_modules/@qvac/fabric/prebuilds/<host>`.
• Docs (`INTEGRATION.md`, overlay action, fabric-stack CI QIP) describe the two-layer layout.

---

:no_entry_sign: *Out of scope*

• Splitting other fat addons (`llm-llamacpp`, `asr-ggml`, `vla-ggml`) — same pattern, separate change once fabric proves the publish path
• Migrating remaining direct-vcpkg addons onto `@qvac/fabric`
• Changing ggml backend load semantics, SONAME, or the C API
• Yarn v1 support
• Replacing npm distribution with P2P or GitHub Releases
• Windows CUDA, extra CUDA archs, or changing ASR’s in-tree CUDA packaging

---

:sparkles: *Nice to haves*

• Phase 2 vendor packages for CUDA and HIP, with HIP removed from the default linux-x64 slice
• Unpacked-size CI gate per slice, with a documented budget headroom for the next backend
• Drop redundant Android arch copies from the published android package if the mobile harness can take a single `android-arm64` prebuild
• Share the publish-slicing action so other addons can opt in later

---

*Implementation phases (suggested)*

*Phase 1* — Publish slicing + meta `optionalDependencies` + `#binding` imports map (bare-collabora); headers stay in meta; overlay/CMake/`resolveBackendsDir()` follow the platform package (needed for the split to install). CUDA/HIP vendor packages stay on hold.

*Phase 2 (optional, CUDA)* — `@qvac/fabric-linux-x64-cuda` (and HIP extract) as opt-in packages; loader path from the meta helper
Default linux-x64 tarball stays publishable

---

*Author checklist*

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
