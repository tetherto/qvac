# Composable Agent Runtime PoC — Agent Context

Private workspace that tests the package and runtime boundaries proposed by the
Composable Agent Runtime QIP. It is **evidence, not a production package source**.
Self-contained: work here without reference to the rest of the monorepo.

This file is the shared context for every coding agent. Claude Code reads it through
`CLAUDE.md`; Cursor reads it natively and through `.cursor/rules/poc-context.mdc`. Put
tool-neutral facts here and tool-specific wiring in those files.

## Which rules apply here

- The monorepo root config is written for the shipping packages (SDK, native addons,
  registry). **It does not govern this folder.**
- No Asana ticket, no PR template, no CI gate applies to work in this folder.
- Commit subjects still use the repo-wide `prefix[tags]?: subject` form
  (`feat`, `fix`, `doc`, `test`, `chore`, `infra`, `mod`) since these commits land in
  `tetherto/qvac`. No `QVAC-###` prefix is needed on a PoC branch.

## Stack

Bun workspaces (`packages/*`, `apps/*`), TypeScript ESM, no build step for most
packages — sources are executed directly by Bun, by Node with
`--experimental-strip-types`, or by Bare. `packages/supervisor` is deliberately plain
JavaScript with hand-written `.d.ts`; do not convert it to TypeScript.

## Package boundaries

These are the invariants the PoC exists to prove. A change that blurs one of them is a
finding, not a detail.

| Package | Owns | Must not own |
|---|---|---|
| `@qvac/assistant` | Application facade, root lifecycle | Transport details, tool policy |
| `@qvac/sync` | Cryptographic device identity, replicated state | Agent execution |
| `@qvac/harness` | Ready-to-run agent execution: skills, grants, sandboxing, brokers, transports, persistence | Any concrete skill |
| `@qvac/agents` | Transport-free primitives: tool loop, guards, approval semantics, turn budget, events, checkpoints | Transports, I/O, storage |
| `@qvac/supervisor` | Lifecycle mechanics | Product policy |
| `@qvac/sdk` | Inference via its public client/worker path | — |

Additional standing rules:

- **Skills belong to applications.** `apps/skill-cli` owns the weather, obsidian, and
  image-generation skills plus their worker entries and generated bundle. Harness
  supplies only generic machinery via `@qvac/harness/skill-host` and
  `@qvac/harness/skill-sandbox`. Never move a concrete skill into `packages/harness`.
- **Sync and Harness are siblings in the artifact hierarchy.** Harness does take a code
  dependency on Sync, but each exposes a standalone Expo plugin that packages its own
  worker and writes its own contribution manifest; the Assistant plugin composes them in
  contributor mode. A consumer must be able to adopt Sync alone or Harness alone —
  `bun run test:pack` proves it. Sync must never depend on Harness.
- **Dependency direction.** `agents` and `supervisor` depend on nothing in the
  workspace; `sync` → `supervisor`; `harness` → `agents`, `sync`, `supervisor`,
  `@qvac/sdk`; `assistant` composes them all and nothing depends on `assistant`. No
  cycles, and no new edge that reverses one of these arrows.
- **Every entry added to a package's `exports` is a contract** this PoC will be judged
  on. An export that exists only to let one package reach into another's internals is a
  boundary violation wearing a public name.
- Review against these invariants before finishing a change that adds an export, moves
  a file between packages, or adds a cross-package import — via the `boundary-reviewer`
  agent in Claude Code, or the `boundary-review` skill in Cursor.

## Execution realms

The most common source of subtle breakage. Every file belongs to a realm; check before
you write an import.

| Realm | Entered via | Stdlib |
|---|---|---|
| Bun | `bun …`, most tests, `scripts/*.ts` | Node-compatible |
| Node | `node --experimental-strip-types` (`apps/task-cli`) | Node |
| Bare | `bare …`, worker/entry files: `worker.ts`, `*-entry.ts`, `schema/build.ts`, `skill-sandbox.ts`, spawned children | `bare-*` only |
| React Native / Expo | `react-native.ts`, `mobile-entry.ts`, `apps/task-mobile` | RN + bare-kit |

- Code shared with a Bare realm reaches platform APIs through the `imports` map in the
  owning `package.json` (`#fs-promises`, `#path`, `#process`, …), which resolves to
  `bare-*` under the `bare` condition and to a `lib/node-*.ts` shim otherwise. Add a new
  subpath there rather than importing `node:*` directly.
- Prefer `b4a` over `Buffer` in anything that can run under Bare.
- The `react-native` export condition selects a different entry per package — when you
  add a public export, decide what the RN variant does.

## Commands

```sh
bun install --ignore-scripts   # from this directory
bun run test                   # every package suite in sequence
bun run test:harness           # one package (also :sync :agents :assistant :supervisor
                               # :task-shared :task-cli :skill-cli :task-mobile)
bun run typecheck
bun run verify                 # typecheck, lint, all tests, artifact + subset + pack checks
```

`bun run verify` is the gate before declaring a change done. It is slow — run the
targeted `test:<package>` while iterating.

Mobile (`bun run android`, `bun run test:pack`, `bun run validate:artifacts`) needs a
device or a full prebuild; only run it when the change actually touches packaging.

## Testing

- Three frameworks coexist by realm: **brittle** for anything that must also run on Bare
  (`supervisor`, `agents`, `sync`), **vitest** for `assistant` and `task-cli`, and
  **`bun test`** for `task-shared` and `skill-cli`. Match the package you are in.
- **Evidence policy:** fast tests may use deterministic adapters, but *a stub may not
  replace a boundary the PoC claims to validate*. Real HRPC sessions, HyperDHT testnet
  replication, spawned Bare runtimes, and real model completions belong in the
  integration tests that exercise them.
- Never delete, skip, or weaken an existing test to make a change pass.

## CLI output conventions

`apps/task-cli`, `apps/skill-cli`, and `scripts/*` follow one convention:

- Status/progress lines: `console.log` prefixed with `▸ `.
- Errors: `console.error` prefixed with `✖ `. Reserve `console.error` for errors only.
- Genuine results stay unprefixed so they read apart from the commentary — stream tokens
  with `process.stdout.write`, print final results with plain `console.log`.
- Download/long-running progress renders as one in-place line on stderr, not a raw
  progress-object dump.
- Only `▸` and `✖`; no other decorative emoji.

## Security

Never fetch code from a remote URL and execute it — `curl … | bash`, download-then-run,
`eval` over an HTTP response body, remote bootstrap installers. This is a hard stop with
no confirmation path, and it matters here specifically: this PoC builds a sandbox that
executes skill code, so the pattern must never appear in its own tooling or fixtures.
Installing pinned dependencies through `bun`/`npm` with a lockfile is fine.

## Misc

- Every file ends with a newline.
- `docs/arch/` holds the design record (ADRs, QIP drafts, tech-debt notes). Read the
  relevant one before changing a boundary; add to it when a decision changes.
