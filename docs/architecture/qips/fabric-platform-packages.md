# QIP: Split `@qvac/fabric` into per-platform npm packages

*Status:* Draft — for team review
*Authors:* @juan.arias
*Created:* 2026-09-01

---

## People to consult before posting

• *Fabric / addon pod lead* (`packages/fabric`, `qvac-fabric-llm.cpp`) — shared runtime contract, backend layout, SONAME stability
• *DevOps / CI* — `on-merge-nx` slicing, `overlay-local-fabric`, prebuild artifact layout
• *npm-runtime consumer owners* (`.github/fabric-consumers.json`) — `resolveBackendsDir()`, CMake template, the consumer range bump
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

The meta keeps `binding.js`, `backends.js`, `prebuilds/include/` and
`prebuilds/share/qvac-fabric/` (the slicer's `--keep-dirs`, fed from
`prebuildExtraDirs`). Each platform package nests its host runtime one level down,
under `addon/prebuilds/<host>/qvac__fabric.bare` with the DL backends in
`qvac__fabric/`. The `addon/` directory carries an inner `package.json` named
`@qvac/fabric`. `require.addon()` and cmake-bare's `include_bare_module()` both
take the artifact basename from that manifest, so the file stays
`qvac__fabric.bare`. The `DT_NEEDED qvac__fabric@0.bare` that every shipped
consumer records keeps resolving.

### Load contract

`binding.js` tries `require.addon()` first and falls back to
`require('#host-addon')`. `#host-addon` is a Bare `imports` map keyed on platform
and arch, like [bare-collabora](https://github.com/holepunchto/bare-collabora).
`bare-pack --host` resolves the map for the target host, which a runtime
`process.platform` switch cannot do. Every arm is
`[<platform package>, "./addon-unavailable.js"]`, so the specifier resolves even
where the slice is not installed. That fallback throws an error naming the exact
package. A `require.addon()` answer that is this package's own JS entry is treated
as a miss, which is the defect #4485 fixed in the sibling addons.

One precedence holds everywhere: a runtime in `@qvac/fabric/prebuilds/<host>`
wins over the platform package. It applies in `binding.js`, in
`backends.js#resolveBackendsDir()`, in CMake `qvac_addon_fabric_layout()`, and in
the SDK's `qvac verify`. That tree exists for fabric 0.17 and earlier, source
builds, linked workspaces and the unsliced GPR tarball. It is also where
`overlay-local-fabric` writes the PR-built runtime, so the overlay and its pinned
callers need no change.

CMake resolves the platform package from fabric's *real* path, as Node does from
inside fabric. It is fabric's dependency, not the consumer's, so under pnpm or a
nested npm install it is not in the consumer's `node_modules`.

### Mobile

npm matches `os`/`cpu` against the install host, never the cross-build target.
`android-arm64` and `ios` slices therefore ship unfiltered and stay out of the
meta's `optionalDependencies` (#4499). Mobile applications add them as direct
dependencies pinned to the exact meta version. The SDK Expo plugin and
`qvac verify prebuilds` already read `#host-addon` for split addons (#4522), and
the bundle manifest lists `@qvac/fabric` as an addon, so fabric's slice is linked
and a missing pin is reported by name.

Consumer addons need the same slices to *build* their Android and iOS prebuilds,
and a CI runner installs only its own host's slice. Each consumer therefore adds
both as exact-pinned `devDependencies`, not `dependencies`, which would ship
about 150 MB of mobile runtime with every desktop install of the addon. The
application still supplies the runtime at run time. Configure fails naming the
missing package rather than failing later at link.

### Publish

`on-merge-nx` slices, publishes each platform package, then publishes the meta
last, so the name consumers depend on never appears without its binaries. A
version already on npm is skipped only on a confirmed hit, and any registry error
other than `E404` fails the release instead of publishing blind. GPR `-mono` dev
builds stay unsliced.

### Consumer migration

Consumers pin `^0.17.x`, which cannot resolve 0.18, so this release changes
nothing for them until they bump. The bump PR moves each consumer's hand-rolled
`resolveBackendsDir()` to `require('@qvac/fabric/backends').resolveBackendsDir()`,
falling back to its own `prebuilds/` on mobile. That subpath must land together
with the range bump: `bare-pack` follows the literal `require()` at bundle time,
and against a 0.17 install the subpath is unexported and fails the mobile bundle.

---

## :twisted_rightwards_arrows: Alternatives considered

- *Fabric-specific slicer and `#binding` map* (this PR's first revision). It
  diverged from the three shipped splits, and SDK mobile tooling reads only
  `#host-addon`, so fabric's slice would have been silently left out of mobile
  bundles.
- *Overlay into a synthetic platform package.* The overlay action would have
  needed new code, and 11 `pull_request_target` callers would have had to drop
  their SHA pin for it. Local-first precedence keeps the existing overlay valid.
- *Platform package first, meta prebuilds second.* An installed release slice
  would shadow the CI overlay, so PR jobs would silently test the released runtime.
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
