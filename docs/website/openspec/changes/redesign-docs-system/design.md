## Context

QVAC is a public monorepo of more than thirty packages. Three of them are developer entry points:

- the SDK: polyglot (JavaScript/TypeScript, Python, Kotlin, Swift soon), runs inference and fine-tuning;
- the CLI: configures and bundles the SDK, and serves a local OpenAI-compatible model provider;
- Compose: higher-level AI primitives such as agents and harnesses, built on the SDK; not yet in the monorepo.

The remaining packages are internal machinery. Developers can use them directly, but the canonical paths are the SDK for inference and Compose for higher abstractions.

The site is a static Next.js + Fumadocs export served from a CDN. Its build host watches `docs-production` and can check out any number of commits. Today:

- SDK and CLI lines are folders on `main`, cut by copying `content/_unpublished/<collection>/next/` and renaming the outgoing folder group (`scripts/cut-line.ts`).
- `src/lib/versions.ts` is the hand-edited manifest every version-shaped surface reads.
- Examples are injected with `remark-code-import` rooted at the monorepo's working tree, so every line injects `main`'s examples.
- The SDK API summary is rendered by TypeDoc + Nunjucks from TSDoc. It stops at first-level parameters.
- The SDK already exports `packages/sdk/contract/` from its Zod schemas, with a `contract:check` freshness gate:
  - `schema.json`: JSON Schema 2020-12 of every wire request and response, nested to primitives, with field descriptions;
  - `manifest.json`: methods and call shapes;
  - `models.json`: 473 registry models with engine and add-on.

  The Python and Kotlin clients are generated from it.
- `qvac serve` already produces an OpenAPI 3.1 document. The CLI is built on Commander.
- Release branches are `release-<pkg>-<x.y.z>`, one per patch. Branch retention deletes those outside a window of three minors. Release tags `<pkg>-v<x.y.z>` are permanent.
- `pr-release-guard.yml` requires a version bump and a changelog section on every pull request into a release branch. `on-merge-nx.yml` publishes add-ons on any push under their package path.

The ecosystem is at version zero. The SDK ships a minor every two weeks, and a line older than a few months has no readers worth a maintenance cost.

## Goals / Non-Goals

**Goals:**

- Document every QVAC software from one static site, with each software's documentation living, versioned, and reviewed with its code.
- Render each line from the commit it documents, examples and generated data included.
- Generate API facts deterministically, nested to primitive types, for readers and agents.
- Make what a page must contain a checked contract, and make a stale page fail its pull request.
- Keep the build trivially testable locally and in pull requests.
- Migrate the SDK and the CLI fully. Add other packages one at a time.

**Non-Goals:**

- A server runtime of any kind. The site stays a static export.
- Long-term retention or compatibility of old lines. Few lines are kept, and an old line is retired instead of maintained.
- Versioning the docs contract or keeping MDX components backward compatible.
- Documenting Compose before it exists. Only the generic mechanisms it needs are specified.
- The build host's capacity, which is handled outside this change.
- Rewriting lines published before the migration. They age out.

## Decisions

### D1. Documentation lives in the package

`packages/<pkg>/docs/users/` holds the published documentation and `packages/<pkg>/docs/contributors/` the maintainer documentation. The audience names follow open-source convention (`CONTRIBUTING.md`, "user guide"), include outside contributors, and avoid `consumers`, which collides with QVAC's consumer apps. The site reads only `docs/users/`. Its root `meta.json` carries the software's `kind`, so no extra file is needed. Examples stay in `packages/<pkg>/examples/`. Ecosystem and Resources stay in `docs/website/content/`.

Alternatives rejected:

- `internal/` + `external/`: the repository is public;
- `dev/` + `user/`: both audiences are developers;
- a sibling `docs-site/` folder: splits a package's documentation across two roots.

### D2. One versions file per software, pinning lines to commits

`docs/website/versions/<software>.json` merges manifest and lock:

```jsonc
{
  "package": "@qvac/sdk",
  "kind": "collection",          // collection | package
  "repo": null,                  // another repository, for software outside the monorepo
  "paths": ["packages/sdk/docs/users", "packages/sdk/examples",
            "packages/sdk-python/examples", "packages/sdk/contract"],
  "retain": 3,
  "retired": ["v0.20"],
  "lines": [{ "version": "v0.24", "ref": "release-sdk-0.24.1", "sha": "<sha>" }]
}
```

`ref` states intent and `sha` makes the build a pure function of `main`. Line order states currency: the first line is current. One file per software keeps concurrent release pins from conflicting.

Alternatives rejected:

- **A1, copying folders on `main`:** grows with every release, carries `main`'s examples into old lines, and causes rename ambiguity in merges.
- **A2, pointing at branches:** branches move, so builds are not reproducible, and retention deletes them.
- **A3, committing materialized snapshots:** kept only as a fallback. The build host can fetch commits.
- **A4, reading registry artifacts:** heterogeneous across npm, PyPI, and Maven, and leaves no post-release correction.

### D3. Materialization before the build

`docs:materialize` runs `git archive <sha> -- <paths>` for every line into a gitignored `.content/<collection>/<folder>/` and writes the current line as the Fumadocs folder group `(vX.Y)`. Everything downstream — fumadocs-mdx, the custom tree, the switcher, the agent corpora, the sitemap — reads those folders as it reads `content/docs/` today. Examples are imported relative to the line's own root.

- `--override <software>@<line>=<path|sha>` substitutes one line. A pull request into `main` uses its working tree. A pull request into a release branch uses the site from `main` and its own head.
- `--include-dev` adds the line under development, from `main`'s `docs/users/`, for staging only.

The manual cut disappears: publishing is adding or moving a pin.

### D4. Deployment is unchanged

Staging builds `main`. Production builds `docs-production`, which only the existing manual promotion workflow advances, exactly as today. A pinned line reaches production at the next promotion.

Alternatives deferred:

- fast-forwarding `docs-production` automatically on pin changes;
- serving production from `main`.

Both change how the site is operated rather than how it is documented, and are left out of this redesign's scope.

### D5. Correcting a released line

A line follows the release branch of the highest patch in its minor. A documentation-only change — every path under `packages/*/docs/users/**` — to a release branch:

- is exempt from the version-bump and changelog guards;
- is excluded from package publish triggers;
- triggers a workflow that opens a pull request on `main` moving that line's pin.

One shared classifier decides "documentation-only" for every workflow.

Alternative kept as a fallback: no corrections to released lines. A fix then waits for the next minor, at most two weeks.

### D6. Collections

- Ecosystem (unversioned) holds a Packages section: one entry per internal package, each versioned through `kind: package`.
- SDK, CLI, and Compose are the versioned collections.
- Resources stays unversioned.
- Research (Hugging Face) and the assistant app are departures.

A package appears only when it has a versions file, so inclusion is an explicit list. Test, CI, and smoke packages are never listed. The polyglot SDK is one collection with one line per minor. Every language client carries the SDK's version.

### D7. The docs contract, unversioned

The contract has five layers:

1. software kinds (`entry-point`, `package`), in YAML;
2. page types, in YAML: required sections, frontmatter fields, data components;
3. MDX scaffolds for new pages;
4. data components that render facts;
5. writing guidance in agent skills.

Facts come from data, prose comes from people and agents, and they never share a passage. The contract is checked on pull requests over the content being authored. The build only renders. A contract change therefore never breaks an older line's build, and the contract needs no versioning. Nunjucks page rendering is retired. A generated page would overwrite prose, while a component reading data never does.

### D8. API facts are extracted, never written

JSON Schema is the common shape of type facts, rendered by one nested, collapsible schema table.

| Software | Source | Generated artifact |
|---|---|---|
| SDK | Zod schemas → `contract/` (exists) | used as is |
| Compose | Zod schemas → the SDK's exporter, reused | `contract/` |
| Internal packages | public `index.d.ts` → TypeDoc JSON → normalizer | `docs/users/_generated/api.json` |
| CLI | Commander tree → walker | `docs/users/_generated/cli.json` |
| `qvac serve` | fastify-swagger, exported without listening | `docs/users/_generated/openapi.json` |
| Models | `contract/models.json` | used as is |

The normalizer expands interfaces, object aliases, literal unions, arrays, and overload lists. Every other type is shown as TypeDoc's own type text with a link to the declaration. It formats what TypeDoc resolved and interprets nothing, which keeps it from becoming an API-doc engine.

Anything that needs a package's toolchain runs in the package, is committed, and carries a `--check` freshness gate. The site never runs a package toolchain, which keeps materializing an old line a plain `git archive`.

Alternatives rejected:

- **Agents generating API JSON:** non-deterministic, with no ground truth for review.
- **Long TSDoc + a custom extractor:** prose duplicated from the schemas, and a language engine to maintain.
- **`fumadocs-typescript` at site build time:** needs every line's dependencies installed.

### D9. TSDoc in the SDK

| Stays in TSDoc | Moves out | Destination |
|---|---|---|
| a one-to-three-line function summary | `@param params.*` | Zod `.describe()` |
| `@deprecated` | return-field descriptions | Zod |
| `@throws` | `@example` | `examples/` |
| status tags | narrative | the MDX page |

About half of the contract's properties carry a description today, and a check requires every public request property to have one. Whether the SDK keeps `@param` for IDE hover is the SDK team's call. The documentation pipeline ignores it either way.

### D10. One polyglot reference, language-switchable

| Part of a reference entry | Shape | Source |
|---|---|---|
| field table | language-agnostic; a language switcher renames fields by each generator's naming rule (`modelId` ↔ `model_id`) | the contract |
| signature card | per language | each language's real surface: TypeDoc for JavaScript, griffe for Python, Kotlin and Swift when published |
| examples | per-language tabs | each language's examples |

A parity check requires every contract method to exist in every published language.

Alternative rejected: one reference per language, which would triplicate the same semantics.

### D11. Bindings on the projected surface

A hand-written page declares `binds: [<symbol-id>, …]`. The package's `docs/users/api-bindings.lock.json` records each binding's surface hash at the last review. Hashing source files is rejected: refactors and comments produce false alarms, and transitive type changes go unnoticed. The projected surface is:

- the contract definitions for the SDK and Compose;
- the normalized TypeDoc projection for packages;
- the command model and the OpenAPI document for the CLI.

On a pull request:

- a changed surface with an unchanged lock fails and names the page;
- running `docs:lock` records the review in the diff.

Rigor depends on the kind:

- `entry-point`: bindings per symbol, plus a coverage check that every public symbol is bound;
- `package`: one whole-surface binding, no coverage check.

Generated pages need no binding, because the freshness gate covers them.

### D12. Agent projections

Each line's corpus gains one compact card per function: a TypeScript-style signature with expanded types and field descriptions. It is cheaper in tokens than JSON Schema and closer to what agents read well. Per-method JSON Schema slices are published alongside, because the whole `schema.json` is 1.2 MB.

### D13. Retention

`retain` is at most the branch-retention window, so every pinned commit stays reachable without extra tags. Entry points keep 3 lines, packages keep 2. A retired version is recorded in `retired`. The build turns each one into a redirect of its versioned paths to the current line.

### D14. Software outside the monorepo

`repo` lets a versions file pin another public repository. Materialization fetches `<repo>@<sha>`. That repository needs three things:

- the gates through a reusable workflow, which requires the tooling to run on an arbitrary path;
- pin updates by token, or by a daily poll of its tags;
- the documentation skills, distributed to it.

These costs vanish if the software moves into the monorepo.

### D15. Migration scope

The SDK and the CLI migrate completely. Their unreleased line moves from `content/_unpublished/<collection>/next/` to their packages, and the first release afterwards is the first pinned line. Lines published before the migration are not reconstructed. Every other package is added one at a time, starting with `translation-nmtcpp` and `llm-llamacpp`.

## Risks / Trade-offs

- **[Old lines break when a component changes]** → Few lines are kept. Either an agent updates the live lines on their release branches, or the oldest line is retired.
- **[The build host cannot hold all lines]** → This is handled outside this change. `retain` bounds the build in any case.
- **[Pinned commits become unreachable]** → `retain` stays within the branch-retention window. Release tags back released commits.
- **[A docs-only commit on a release branch triggers a publish]** → One classifier is used by both the guards and the triggers. Its tests cover mixed diffs.
- **[TypeDoc renders an exotic type poorly]** → Expansion is bounded, and the fallback shows the declared type text with a link.
- **[Wire contract and client signature differ]** (client-only returns such as `tokenStream`, RPC options) → The exporter adds a client-function map.
- **[Losing IDE hover for SDK parameters]** → The SDK team decides. Generating `.d.ts` field docs from the contract is a later option.
- **[Fewer published lines than today's promise]** → Accepted at version zero, and revisited when the user base needs it.

## Migration Plan

1. Validate the design with a local proof of concept: the SDK, the CLI, and two internal packages, with two lines pinned to two commits, schema tables, the language switcher, and a failing-then-passing binding. It is not merged.
2. Build the foundation: versions files, materializer, custom tree, examples per line, and derived manifest. The SDK and CLI content is still read in place through an override, so the site keeps working.
3. Move the SDK and the CLI into their packages. Switch their versions files to pins. Remove the cut tooling and `_unpublished/`.
4. Add the API reference, the contract, the bindings, and the CI automation, phase by phase.
5. After each phase, sync this change's deltas into the main specs. Archive the change at the end.

Rollback before step 3 is reverting the site changes. After step 3, the previous folder model can be restored from git history, because no package history is rewritten.

## Open Questions

- The prose elements of each page type, to be agreed with the documentation owner and folded in through an update of this change.
- The Packages inclusion list.
- Whether the SDK keeps `@param` tags.
- Where Compose will live: the monorepo or its own repository.
- Whether `docs/website/.claude/skills` is tracked in git.
