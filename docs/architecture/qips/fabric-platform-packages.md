# QIP: Split `@qvac/fabric` into per-platform npm packages

*Status:* Draft — for team review
*Authors:* @juan.arias
*Created:* 2026-09-01

---

## People to consult before posting

• *Fabric / addon pod lead* (`packages/fabric`, `qvac-fabric-llm.cpp`) — shared runtime contract, backend layout, SONAME stability
• *DevOps / CI* — `on-merge-nx` slicing, `overlay-local-fabric`, prebuild artifact layout
• *npm-runtime consumer owners* (`.github/fabric-consumers.json`) — platform package declarations, CMake template, the consumer range bump
• *SDK / mobile owners* — Expo linker and `qvac verify` reading `#host-addon`, mobile apps pinning the cross-built slices
• *Lead / Architect* — package boundary, install contract, CUDA/HIP as a second split axis

---

## Approvers

| Role | Approver | Status |
| --- | --- | --- |
| Lead / Architect | @Dima / @Yury Samarin | |
| Head of QVAC | @Marco | |
| CTO | @Mathias Buus | |

---

## :mag: Problem

`@qvac/fabric` is one npm tarball carrying every prebuild in the matrix: five
desktop hosts, `android-arm64`, and three iOS flavours, plus the ROCm/HIP
backend on linux-x64. `@qvac/fabric@0.17.0` unpacks to 574 MB.

- Every install of a fabric consumer downloads every other host's runtime: a
  Linux builder pulls Windows, macOS, iOS and Android binaries, and the reverse.
- Publishes in this size class fail in practice (`413 Payload Too Large`, CLI
  timeouts). Native binaries compress poorly.
- The next planned increment is a CUDA ggml backend, a large multi-arch `.so`.
  Adding it to the single tarball is the near-term path to an unpublishable
  package.

`@qvac/asr-ggml`, `@qvac/tts-ggml` and `@qvac/audiogen-ggml` hit the same wall and
already ship per platform. Fabric should use the same contract, so the SDK tooling
built for them covers it too.

---

## :bulb: Solution

Publish `@qvac/fabric` as a *meta package* plus *per-platform packages*, sliced
at publish time from the merged prebuilds artifact by the shared
`scripts/ci/slice-platform-packages.mjs` (`slicePlatformPackages` in
`packages/fabric/project.json`). One source tree; no per-platform packages in the
monorepo.

```
consumer addon
  └── @qvac/fabric                    meta: loader, headers, CMake config
        optionalDependencies (injected at publish, os/cpu/libc filtered)
          ├── @qvac/fabric-linux-x64
          ├── @qvac/fabric-linux-arm64
          ├── @qvac/fabric-darwin-arm64
          ├── @qvac/fabric-darwin-x64
          └── @qvac/fabric-win32-x64
        cross-built, never auto-selected (direct dependency of the app)
          ├── @qvac/fabric-android-arm64
          └── @qvac/fabric-ios         (device + simulator flavours)
```

### Layout

The meta keeps `binding.js`, `prebuilds/include/` and
`prebuilds/share/qvac-fabric/` (the slicer's `--keep-dirs`, fed from
`prebuildExtraDirs`); it is not an addon. Each platform package is an ordinary
one: `addon: true`, `index.js` is `module.exports = require.addon()`, and its
runtime is built under the package's own mangled name,
`prebuilds/<host>/qvac__fabric-<suffix>.bare`, with the DL backends in
`prebuilds/<host>/qvac__fabric-<suffix>/`. Every iOS host shares the suffix
`ios`. `require.addon()`, `bare-pack` and `bare-link` find it with no inner
manifest posing as `@qvac/fabric`.

The runtime's SONAME follows: consumers record
`DT_NEEDED qvac__fabric-<suffix>@<major>.bare`, so the platform package names
are part of the ABI. Shipped consumers that recorded `qvac__fabric@0.bare` need a
rebuild against 0.21.

### Load contract

`binding.js` is one line, `module.exports = require('#host-addon')`, as in
[bare-collabora](https://github.com/holepunchto/bare-collabora/blob/main/binding.js).
The Bare module lexer, which `bare-pack` and `bare-link` walk the graph with,
only follows string-literal specifiers. A `require()`, `require.resolve()`,
`require.addon()` or `require.addon.resolve()` with a computed specifier is
invisible to it and does not work bundled; `scripts/ci/check-bundler-requires.mjs`
fails a package that has one.

`#host-addon` is a Bare `imports` map keyed on platform and arch. `bare-pack
--host` resolves it for the target host, which a runtime `process.platform`
switch cannot do. Each supported host maps to its platform package alone, with
no array fallback, so a missing install fails `bare-pack` (and fails at run time
naming the package) instead of producing a bundle that only throws once
launched. Hosts with no platform package map to `addon-unavailable.js`.

There is no local-first precedence. A source build, a linked workspace and the
CI overlay all become loadable the same way an install does: the slicer's
`--link-local` mode (`npm run link:platform`) wraps `prebuilds/<host>/` as
`node_modules/@qvac/fabric-<suffix>` inside the meta. `overlay-local-fabric`
writes the PR-built runtime into the installed meta's `prebuilds/` and then runs
it, so the PR runtime shadows the released platform package for that job.

The native runtime finds its own backends: `qvac_fabric_backends_dir()` returns
`$QVAC_FABRIC_BACKENDS_DIR`, else `<module dir>/qvac__fabric-<suffix>` when it
exists (a platform package), else the module's directory (where `bare-link`
flattens them in an app). No JavaScript resolves a backends path.

CMake resolves the platform package from fabric's *real* path, as Node does from
inside fabric, and also checks the meta's own `node_modules`, where
`link:platform` stages it.

### Mobile

npm matches `os`/`cpu` against the install host, never the cross-build target.
`android-arm64` and `ios` slices therefore ship unfiltered and stay out of the
meta's `optionalDependencies` (#4499); the slicer declares them as optional
`peerDependencies` instead. Mobile applications add them as direct dependencies
pinned to the exact meta version. Because each platform package is an ordinary
addon reached through declared dependencies, `bare-link` links it with no extra
pass, and the SDK bundles the platform packages `bare-pack` resolves as the
addons. A missing mobile pin fails `bare-pack`, which the SDK reports as
`HostPrebuildsMissingError` with the exact pins (or installs them when asked to).

Consumer addons declare the platform packages too, since `bare-link` only
rewrites a `DT_NEEDED` it can match to one of the package's own dependencies:
the desktop ones as `optionalDependencies`, the mobile ones as optional
`peerDependencies`. They need the mobile slices to *build* their Android and iOS
prebuilds, and a CI runner installs only its own host's slice, so each consumer
also adds both as exact-pinned `devDependencies`, not `dependencies`, which would
ship about 150 MB of mobile runtime with every desktop install of the addon. The
application still supplies the runtime at run time. Configure fails naming the
missing package rather than failing later at link.

### Publish

`on-merge-nx` slices, publishes each platform package, then publishes the meta
last, so the name consumers depend on never appears without its binaries. Any
registry error other than `E404` fails the release instead of publishing blind.
A slice already on npm is skipped when its meta is released, as on a follow-up
merge to the release branch. With the meta missing, the release is partial: a
slice is skipped only if its published tarball matches the staged one (a retry of
the same build), otherwise the run fails before publishing anything, because the
meta, which carries the headers every consumer compiles against, would pair with
binaries from another commit. GPR `-mono` dev builds stay unsliced.

### Consumer migration

Consumers pin a caret range below 0.21, which cannot resolve it, so this release
changes nothing for them until they bump. The bump PR drops each consumer's
`resolveBackendsDir()` (fabric no longer exports `./backends`; the runtime finds
its backends), rebuilds against the `qvac__fabric-<suffix>` SONAME, and adds
the platform package declarations above. The split speech addons (`tts-ggml`,
`asr-ggml`, `audiogen-ggml`) follow the same contract for their own platform
packages: one-line `binding.js`, modules named `qvac__<addon>-<suffix>`, and
backends found natively next to the module.

---

## :twisted_rightwards_arrows: Alternatives considered

- *Fabric-specific slicer and `#binding` map* (this PR's first revision). It
  diverged from the three shipped splits, and SDK mobile tooling reads only
  `#host-addon`, so fabric's slice would have been silently left out of mobile
  bundles.
- *Local-first precedence with a `require.addon()` attempt before
  `#host-addon`, and a JS `resolveBackendsDir()`* (the 0.18 to 0.20 design). The
  fallback chain and the backends path were computed specifiers, invisible to the
  module lexer, so `bare-pack` of an app requiring `@qvac/fabric` failed, and
  mobile CI needed an overlay script to put the runtime where `bare-link` looks.
- *Array fallbacks in `#host-addon`.* A bundle missing its platform package
  would pack fine and throw only on device.
- *JS `process.platform` switch.* `bare-pack` either takes the packer's host or
  follows every branch.
- *Install-time download (postinstall / CDN).* Breaks `--ignore-scripts` and
  offline CI, and is not lockfile-pinned.
- *CUDA as another DL `.so` in the same tarball.* The right runtime design but the
  wrong distribution design: the bytes still ship.

---

## :scales: Consequences

### Positive impact

- A host downloads only the runtime it can load; the linux-x64 slice has headroom
  for CUDA under the slicer's 450 MB per-slice budget.
- Consumers keep one dependency name, and the loader, CMake template, SDK tooling
  and publish job are the ones the three split addons already use.

### Trade-offs reviewers must accept

- *Optional-dependency installs fail at runtime, not at install.* Yarn v1 and
  `--omit=optional` install no runtime. `addon-unavailable.js` names the package
  and the cause.
- *Mobile apps gain two direct dependencies* (`@qvac/fabric-android-arm64`,
  `@qvac/fabric-ios`) pinned to the fabric version their addons resolve. The SDK
  names the pin when it is missing.
- *N+1 packages per release, lockstep versions.* The slicer refuses a missing
  host, a binary-less host, missing meta dirs, or an oversized slice.
- *Phase 1 still ships HIP (and later CUDA) to every linux-x64 host.* `os`/`cpu`
  cannot tell NVIDIA from AMD from CPU-only.

---

## :no_entry_sign: Out of scope

- Opt-in vendor packages (`@qvac/fabric-linux-x64-cuda`, a HIP extract) — a
  second axis on the same contract, proposed separately.
- Changing ggml backend load semantics, the SONAME, or the C API.
- Yarn v1 support; replacing npm distribution.

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
