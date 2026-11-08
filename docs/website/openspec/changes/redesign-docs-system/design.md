## Context

QVAC is a public monorepo of more than thirty packages. Today two of them are products — software a developer uses directly:

- the SDK: polyglot (JavaScript/TypeScript, Python, Kotlin, Swift soon), runs inference and fine-tuning;
- the CLI: configures and bundles the SDK, and serves a local OpenAI-compatible model provider.

More products will come. The remaining packages are the platform the products are built on. Developers can use them directly, but the canonical path to each capability is a product.

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
- Make a stale page fail its pull request, and make a platform package's minimal pages a checked contract.
- Keep the build trivially testable locally and in pull requests.
- Migrate the SDK and the CLI fully, touching only `sdk`, `sdk-python`, `sdk-kotlin`, and `cli`.
- Ship the Packages mechanism tested with a fixture, so internal packages can be added one at a time afterwards.

**Non-Goals:**

- A server runtime of any kind. The site stays a static export.
- Long-term compatibility of old lines. An old line is retired when unsupported, or updated, rather than kept compatible.
- Versioning the docs contract or keeping MDX components backward compatible.
- Depending on which products exist, or how many. A future one is one more versioned collection, and nothing in this design names it.
- The build host's capacity, which is handled outside this change.
- Rewriting lines published before the migration. They age out.
- Documenting any internal package. A proof-of-concept branch demonstrates three, and they are added after this change.
- Changing any package other than `sdk`, `sdk-python`, `sdk-kotlin`, and `cli`. Completing the Zod field descriptions in `packages/inference` is therefore deferred.

## Decisions

### D1. Documentation lives in the package

`packages/<pkg>/docs/users/` holds the published documentation and `packages/<pkg>/docs/contributors/` the maintainer documentation. The audience names follow open-source convention (`CONTRIBUTING.md`, "user guide"), include outside contributors, and avoid `consumers`, which collides with QVAC's consumer apps. The site reads only `docs/users/`. The software's `kind` is declared once, in its versions file (D2). Examples stay in `packages/<pkg>/examples/`. Ecosystem and Resources stay in `docs/website/content/`.

Alternatives rejected:

- `internal/` + `external/`: the repository is public;
- `dev/` + `user/`: both audiences are developers;
- a sibling `docs-site/` folder: splits a package's documentation across two roots.

### D2. One versions file per software, pinning lines to commits

`docs/website/versions/<software>.json` merges manifest and lock:

```jsonc
{
  "package": "@qvac/sdk",
  "kind": "product",         // product | platform
  "repo": null,                  // another repository, for software outside the monorepo
  "paths": ["packages/sdk/docs/users", "packages/sdk/examples",
            "packages/sdk-python/examples", "packages/sdk/contract"],
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

`docs:materialize` runs `git archive <sha> -- <paths>` for every line into a gitignored snapshot, `.lines/<software>/<version>/`, which mirrors the repository layout and transpiles the line's examples there. It then copies the documentation root to `content/docs/<path>/<folder>/` and writes the current line as the Fumadocs folder group `(vX.Y)`. A materialized folder carries a `.materialized` marker and a `.gitignore` that ignores itself, and it is removed when its line is no longer declared. Materializing into `content/docs/` rather than a separate root means everything downstream — fumadocs-mdx, the custom tree, the switcher, the agent corpora, the sitemap, the checks — reads lines exactly as it reads them today. A remark plugin roots each materialized line's `file=<rootDir>/…` imports at its snapshot.

A line still held under `content/docs/` from before its package migration is declared `inPlace` and left untouched. It is transitional: the migration replaces it with pinned lines.

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

- Ecosystem (unversioned) holds a Packages section: one entry per internal package, each versioned through `kind: platform`.
- One versioned root collection per product, declared by a versions file of kind `product`. Today these are the SDK and the CLI. The design does not depend on their number. Adding a product is adding its versions file and its slot in the collection order, with no other site change.
- Resources stays unversioned.
- Research (Hugging Face) and the assistant app are departures.

A package appears only when it has a versions file, so inclusion is an explicit list. Test, CI, and smoke packages are never listed. The polyglot SDK is one collection with one line per minor. Every language client carries the SDK's version.

### D7. The docs contract, unversioned

This change ships the part of the contract that can be checked mechanically. It has three layers:

1. the requirements of each software kind, in YAML:
   - a `product` curates its own pages, and the contract requires none;
   - a `platform` package provides an overview, installation, supported platforms or backends, and usage, close to what a package README holds, plus its generated API reference;
2. data components that render facts;
3. writing guidance in agent skills, and a scaffold for a platform package's pages.

Facts come from data, prose comes from people and agents, and they never share a passage. A product's completeness is guarded by the coverage check of its bindings (D11): every public symbol must be described by some page, without the contract dictating which. The contract's checks run on pull requests over the content being authored, and the build only renders. A new contract rule therefore never fails the build of a line pinned before it. Nunjucks page rendering is retired. A generated page would overwrite prose, while a component reading data never does.

The data components (layer 2) are site code that every line renders, so a change to a component's interface can break an older line's build. For example, a component that gains a required prop breaks every page that still omits it. This is accepted at version zero. The contract is not versioned, and components are not kept backward compatible. When a component change breaks an older line, either the live lines are updated on their release branches and re-pinned, or the line is retired. Compatibility guarantees are revisited once older lines have a user base worth supporting.

**Deferred: the editorial contract.** Page types, their required sections and frontmatter, the pages a product must provide, and per-type scaffolds are left to a later change. Product pages are curated case by case, and the pages needed today are the ones each product already has. A high-level taxonomy of product pages may generalize them later. Until then, the rule that a fact is never written as prose is applied by the documentation skill and by review, not by a check.

### D8. API facts are extracted, never written

JSON Schema is the common shape of type facts, rendered by one nested, collapsible schema table.

| Software | Source | Generated artifact |
|---|---|---|
| SDK | Zod schemas → `contract/` (exists) | used as is |
| Any other product | its strongest machine-readable surface; a Zod contract exported like the SDK's is the preferred shape | per source |
| Internal packages | public `index.d.ts` → TypeDoc JSON → normalizer | `docs/users/_generated/api.json` |
| CLI | Commander tree → walker | `docs/users/_generated/cli.json` |
| `qvac serve` | fastify-swagger, exported without listening (`renderOpenApiSpec`) and rendered by the same schema table, since OpenAPI 3.1 schemas are JSON Schema | `docs/users/_generated/openapi.json` |
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

This change trims the SDK client TSDoc to the left column. The trimming is essential: long TSDoc blocks bury the code they annotate, and every fact they repeat is a second copy that drifts. Field descriptions reach readers and agents through the site (D12), not through the source. About half of the contract's properties carry a description today. A check reports every public request property without one, but does not fail. The descriptions live in `packages/inference`, which this change does not touch. `@param` tags are removed. IDE hover is read by coding agents now, not by people writing code by hand, and agents get every field description from the function's card (D12). Verbose TSDoc is not a source of truth: it repeats facts that drift, it buries the code, and it can mislead a coding agent.

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

- the contract definitions for contract-based software such as the SDK;
- the normalized TypeDoc projection for packages;
- the command model and the OpenAPI document for the CLI.

On a pull request:

- a changed surface with an unchanged lock fails and names the page;
- running `docs:lock` records the review in the diff.

Rigor depends on the kind:

- `product`: bindings per symbol, plus a coverage check that every public symbol is bound;
- `platform`: one whole-surface binding, no coverage check.

Generated pages need no binding, because the freshness gate covers them.

### D12. Agent projections

Each line gains one compact card per function: a TypeScript-style signature with expanded types and field descriptions. It is cheaper in tokens than JSON Schema and closer to what agents read well. Per-method JSON Schema slices are published alongside, because the whole `schema.json` is 1.2 MB.

The site is the single place where humans and agents find everything about using QVAC: prose, examples, API facts, for the version in use. The projections serve that goal:

- **Every agent channel carries them:** the line's `llms.txt` corpus, the Markdown twin of each reference page, and the MCP server. Whichever channel an agent enters by, it reaches the same complete content.
- **The agent protocol page declares the site the reference source.** An agent that has found the site learns that the API, the prose, and the examples of its version are all there, and that the site takes precedence over package sources. A person pointing an agent at the site can therefore rely on it being covered.

Cards are not shipped inside packages. A partial copy beside the code would compete with the site, and an agent satisfied by it would miss the prose and the other resources.

### D13. Retirement

No number of lines is imposed. Limiting lines only worked around the build host's capacity, which this change has to solve anyway. A line stays published until the team stops supporting its version. Retiring it is one edit to its versions file: moving the version from `lines` to `retired`. The materializer then removes its folder.

The redirect rules of every line are generated from the versions files. `public/_redirects` carries two markers in the positions those rules must hold. After `next build`, `scripts/write-line-redirects.ts` expands them in `out/_redirects`:

- every published line that is not current gets its rewrite, redirect, and splat;
- every retired line gets three redirects to the same path in the current line.

Neither publishing nor retiring a line edits `public/_redirects`.

### D14. Software outside the monorepo

`repo` lets a versions file pin another public repository. Materialization fetches `<repo>@<sha>`. That repository needs three things:

- the gates through a reusable workflow, which requires the tooling to run on an arbitrary path;
- pin updates by token, or by a daily poll of its tags;
- the documentation skills, distributed to it.

These costs vanish if the software moves into the monorepo.

### D15. Migration scope

The SDK and the CLI migrate completely. Their unreleased line moves from `content/_unpublished/<collection>/next/` to their packages, and the first release afterwards is the first pinned line. Lines published before the migration are not reconstructed.

This change modifies only `sdk`, `sdk-python`, `sdk-kotlin`, and `cli`:

- their `docs/` folders change freely;
- their TSDoc is trimmed;
- any other source or contract change is reviewed case by case.

The client-function map that D10 needs is derived in `docs/website` from `contract/manifest.json` and TypeDoc wherever possible, rather than by extending the SDK's contract exporter. No internal package is documented by this change. The Packages mechanism is tested with a fixture package, and internal packages are added one at a time afterwards.

## Risks / Trade-offs

- **[Old lines break when a component changes]** → Few lines are kept. Either an agent updates the live lines on their release branches, or the oldest line is retired.
- **[The build host cannot hold all lines]** → This is handled outside this change. Retiring unsupported lines keeps the published set in check.
- **[Pinned commits become unreachable]** → A release commit stays reachable through its release tag. A documentation-only fix committed after the tag is reachable only through its release branch. If branch retention deletes that branch while the line is still published, the commit can become unfetchable. Handling this is deferred as a future improvement of the docs system.
- **[A docs-only commit on a release branch triggers a publish]** → One classifier is used by both the guards and the triggers. Its tests cover mixed diffs.
- **[TypeDoc renders an exotic type poorly]** → Expansion is bounded, and the fallback shows the declared type text with a link.
- **[Wire contract and client signature differ]** (client-only returns such as `tokenStream`, RPC options) → `docs/website` derives a client-function map from the contract manifest and TypeDoc. An exporter change is a fallback, reviewed case by case.
- **[Fewer published lines than today's promise]** → Accepted at version zero, and revisited when the user base needs it.

## Migration Plan

1. Build the foundation: versions files, materializer, custom tree, examples per line, and derived manifest. The SDK and CLI content is still read in place through an override, so the site keeps working.
2. Move the SDK and the CLI into their packages. Switch their versions files to pins. Remove the cut tooling and `_unpublished/`.
3. Add the API reference, the contract, the bindings, the CI automation, and the Packages mechanism, phase by phase.
4. After each phase, sync this change's deltas into the main specs. Archive the change at the end.

Rollback before step 2 is reverting the site changes. After step 2, the previous folder model can be restored from git history, because no package history is rewritten.

The implementation lives on `docs/docs-system-redesign`. A proof-of-concept branch derived from it, never merged, demonstrates the result for review:

- a mock versioned collection (`compose`) with dummy content inside `docs/website`, showing that one more product is one more collection;
- `llm-llamacpp`, `diffusion-cpp`, and `translation-nmtcpp` migrated to the new model under Ecosystem → Packages.

It is built after the implementation and is not tracked by this change's tasks.

## Open Questions

- The Packages inclusion list.
- Whether `docs/website/.claude/skills` is tracked in git.
