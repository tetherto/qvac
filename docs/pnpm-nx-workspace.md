# pnpm + Nx workspace

QVAC is a single pnpm workspace with Nx layered on top as an affected-graph + config tool. This is the tooling primer.

## pnpm workspace

One workspace, one lockfile, one install. The root `package.json` pins `packageManager: "pnpm@11.17.0"` — match it locally (`corepack enable` or install that exact pnpm). Workspace config lives in `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "packages/registry-server/client"
  - "packages/registry-server/shared"
  - "plugins/*"          # @qvac/opencode-plugin, @qvac/openclaw-plugin

linkWorkspacePackages: true      # plain semver everywhere, no workspace: protocol; resolves a sibling locally when its version satisfies the range, else from the registry
fetchTimeout: 300000             # large binary tarballs (react-native-bare-kit) exceed pnpm's default 60s
fetchRetries: 5
fetchRetryMaxtimeout: 120000
blockExoticSubdeps: true         # reject git/link/exotic subdeps; kept on via the targeted overrides below
overrides:
  hyper-instrument>bare-v8: "^1.0.1"                           # upstream lockfile points bare-v8 at a nonexistent local link:
  "@electron/rebuild>@electron/node-gyp": "10.2.0-electron.2"  # upstream pins a git URL; repoint to a published build
allowBuilds:                     # only these packages may run install/postinstall build scripts
  cld: true
  esbuild: true
  nx: true
  unrs-resolver: true
```

Design choices worth knowing:

- **`linkWorkspacePackages: true` with plain semver (no `workspace:*`)** — a package builds, publishes, and is consumed identically in or out of the monorepo; a local sibling is linked only when its version satisfies the consumer's range, otherwise it resolves from the registry. Note the 0.x caret rule: `^0.43.0` means `>=0.43.0 <0.44.0`, so a sibling already bumped to `0.45.0` resolves from the registry, not the local source (applies to most internal `@qvac/*` ranges today, including the `@qvac/infer-base` consumers pinned to `0.4.x`).
- **`blockExoticSubdeps` + minimal `allowBuilds`** — supply-chain guardrails. Add to `overrides` / `allowBuilds` only with a one-line why (as above). Don't loosen either to make an install pass.

Dev flow: `pnpm install` at the root once, then work in a package dir with its own scripts:

```bash
pnpm install                 # root, once
cd packages/<pkg>
pnpm run build               # or test:unit / test:integration / lint — the package's own scripts
```

A bare local `pnpm install` runs each package's `prepare`/`postinstall` scripts; CI installs with `--ignore-scripts`, so failures in those scripts (e.g. `bare` "No binaries found for target ...", or a cross-package `tsc` type error during a package `prepare`) show up locally but not in CI. If a script step blocks your install, mirror CI:

```bash
pnpm install --force --ignore-scripts
```

## Nx

Nx (`23.1.0`, root devDependency) is **not** a build system here — it's an **affected-graph + config layer** over the pnpm workspace. Every `project.json` target is an `nx:run-commands` that just shells out to a `pnpm run <script>` (or an `echo`, for pure orchestration anchors). It gives us two things:

1. **Affected graph** — the set of packages a diff impacts, transitively via the dependency graph. Used by CI to run only what a change touches.
2. **Config source** — `packages/<pkg>/project.json` `targets.<target>.options.ci` declares each package's CI shape as data.

Most packages carry a `project.json`, pure-JS ones included: 29 of the 31 packages under `packages/`, the exceptions being `inference` and `test-suite`. Three more dirs carry one with no `package.json` at all (`inference-addon-cpp`, `lint-cpp`, `sdk-python`), for 32 files in total. It is required for the native addons, whose `-nx` leaves read `options.ci`, and it is also what lets a package expose a target under a stable name (`test:unit`, `on-pr`) regardless of what its `package.json` script is called.

A `project.json` is **not** required for nx to see a package. Nx derives targets from `package.json` scripts on its own, so `inference`, `test-suite` and the two plugins (`plugins/openclaw`, `plugins/opencode`) are still in the graph with their scripts as targets. `@qvac/inference` resolves a `build` target and appears in `nx show projects --affected -t build` with no `project.json` at all.

The distinction is targets-as-data, not graph membership: add a `project.json` when a package needs `options.ci` or a stable target name, and leave it out when its `package.json` scripts already say everything.

`nx.json` is intentionally minimal:

```json
{
  "targetDefaults": { "build": { "dependsOn": ["^build"] } }
}
```

The dependency graph is derived from workspace `package.json` deps. Two vendor dirs with no `package.json` (`inference-addon-cpp`, `lint-cpp`) are wired into the graph via `implicitDependencies` on the native packages that consume them.

### Using Nx locally

Prefix with `pnpm exec` (Nx isn't global):

```bash
pnpm exec nx show projects                              # list all projects
pnpm exec nx show project @qvac/llm-llamacpp --json     # full RESOLVED config for one package (read this, not project.json directly)
pnpm exec nx graph                                      # interactive dependency graph
pnpm exec nx show projects --affected -t build --base=main --head=HEAD   # what a diff affects = what CI will run
pnpm exec nx run @qvac/llm-llamacpp:test:integration    # run a target (executes its underlying pnpm script)
```

Read the resolved config with `nx show project <name> --json`, not by opening `project.json` — the JSON is the full merged view (defaults + inferred). You rarely need Nx for day-to-day coding (`pnpm run <script>` in the package dir is equivalent); reach for `nx ... --affected` to preview what CI will pick up, and `nx show project --json` when editing a package's `options.ci`.

