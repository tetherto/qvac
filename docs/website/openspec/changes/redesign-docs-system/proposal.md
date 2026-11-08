## Why

The site documents two packages, the SDK and the CLI, and does so from one branch: every published line is a copy of a folder on `main`, cut by hand at each release. That model does not carry the rest of the ecosystem, and it is wrong even for the two packages it serves:

- A line's examples are injected from `main`'s working tree, so an old line shows code that may not run on the version it documents.
- Copying folders on `main` grows every release and breeds merge failures (QVAC-27286), and the documentation is not versioned with the code it describes.
- The API summary lists functions and first-level parameters only. It omits the composition of every parameter, the part readers and agents need most, while the TSDoc that feeds it duplicates field descriptions the Zod schemas already hold.
- Capability pages state facts by hand — inputs, models — that the code already publishes, and nothing binds a page to the API it describes, so a page can fall out of date silently.
- Thirty-odd packages besides the SDK and the CLI have no published documentation.

The ecosystem is at version zero and still taking shape, so the redesign favours a simple first version over long-term compatibility: few lines are kept, and an old line is retired rather than maintained.

## What Changes

- **Documentation lives with the software.** Each package's user documentation moves to `packages/<pkg>/docs/users/`, beside its maintainer documentation in `packages/<pkg>/docs/contributors/`. Ecosystem and Resources stay in the site.
- **A line is rendered from its own commit.** Each documented software is declared in one versions file that pins every published line to a commit. A materialization step extracts each line, its examples, and its generated data from that commit before the build. The site stays fully static.
- **BREAKING (process):** the manual line cut is removed. Publishing a line is updating its pin. `cut-line.ts`, the hand-renamed folder group, and `content/_unpublished/<collection>/next/` go away.
- **Manual retirement.** No number of lines is imposed. A line stays published until the team stops supporting it. Retiring it is moving its version from `lines` to `retired` in its versions file, and its addresses then redirect to the current line. Every line's redirect rules are generated from the versions files. This replaces the rule that a published line is never withdrawn.
- **Publication.** A documentation-only change to a release branch publishes no package and opens a pull request that moves the line's pin. Deployment is unchanged: production builds `docs-production`, which the existing manual promotion workflow advances.
- **Collections.** Every product — software a developer uses directly — has one versioned root collection. The site supports any number of them. Adding one is declaring its versions file and its slot in the collection order. Today they are the SDK and the CLI. Ecosystem gains a Packages section: one entry per internal package, each with its own versions. Research and the assistant app stay departures.
- **API reference from contracts.** API facts are extracted deterministically from the strongest machine-readable source each software has:
  - the SDK's Zod contract;
  - the public `.d.ts` of internal packages;
  - the CLI's command tree;
  - the HTTP server's OpenAPI document;
  - the model registry.

  They are rendered as nested tables for readers and as compact per-function cards and per-method schemas for agents. The polyglot SDK has one language-switchable reference.
- **BREAKING (pipeline):** the Nunjucks-rendered API summary is retired. TSDoc stops being a documentation input except for function summaries, deprecation, throws, and status tags.
- **One kind per software.** Every documented software declares one kind in its versions file: `product` (its own versioned root collection) or `platform` (a sub-collection of Ecosystem → Packages). The kind decides where the software appears, whether a line is current, what the docs contract requires, and how strictly pages bind to its API.
- **Docs contract.** Every software's kind sets its required pages. Every page declares a type. The contract states what each must contain and is checked on pull requests, never at build.
- **Bindings.** Hand-written pages declare the API symbols they describe. A lock records the surface they were reviewed against, so a surface change without a page review fails the pull request.
- **SDK and CLI migrate fully.** This change touches only `sdk`, `sdk-python`, `sdk-kotlin`, and `cli`:
  - their `docs/` folders change freely;
  - their TSDoc is trimmed;
  - any other source or contract change is reviewed case by case.

  No internal package is documented by this change. The Packages mechanism ships tested with a fixture, and internal packages are added one at a time afterwards.

## Capabilities

### New Capabilities

- `api-reference`: how API facts are sourced, generated, kept fresh, and rendered for readers and agents, per kind of software, including the polyglot SDK.
- `docs-contract`: software kinds, page types, what each must contain, and when the contract is checked.
- `docs-bindings`: binding hand-written pages to API symbols, the surface lock, and the drift and coverage checks.
- `ecosystem-packages`: the Packages section of Ecosystem — which packages it lists, how each is versioned, addressed, and entered.

### Modified Capabilities

- `docs-versioning`: lines come from pinned commits through materialization. The versions files replace the hand-edited manifest. Currency is read from manifest order. Lines are retired by hand, and their redirect rules are generated.
- `docs-release-workflow`: publication is a pin update instead of a cut. Released lines are corrected on their release branch. Documentation-only release-branch changes publish no package.
- `docs-collections`: the collection set is defined generically — Ecosystem and Resources, plus one versioned root collection per product. Versioned collections draw their content from packages. Ecosystem holds Packages instead of the Software Inventory.
- `collection-navigation`: a line's navigation is declared in the package's own documentation folder. The Ecosystem sidebar reaches every versioned collection and Packages.
- `versioned-urls`: a new line takes the version-less paths when its pin lands. A retired line's addresses redirect to the current line.
- `software-inventory-docs`: every requirement is removed and superseded by `ecosystem-packages`.
- `agent-entry-points`: the agent protocol page declares the site the reference source for using QVAC.

## Impact

- `docs/website`:
  - new `versions/` files and a materialization script;
  - `src/lib/versions.ts` derived from those files;
  - `src/lib/custom-tree.ts` composes lines and packages from materialized content;
  - new data components (schema tables, model tables, CLI reference, OpenAPI pages);
  - contract and binding checks;
  - removal of `cut-line.ts`, the Nunjucks API pipeline, and `content/_unpublished/`;
  - SDK and CLI content moves out to their packages.
- `packages/sdk`, `packages/sdk-python`, `packages/sdk-kotlin`, `packages/cli`:
  - `docs/users/` and `docs/contributors/`;
  - generated documentation data with freshness checks;
  - SDK TSDoc is trimmed;
  - other source or contract changes only where reviewed case by case.
- Other packages: untouched by this change.
- `.github/workflows`:
  - pull-request checks cover package documentation;
  - a pin-update workflow;
  - a docs-only classifier in the release guards and publish triggers.
- `.agents/skills`: the documentation-update skill becomes contract-driven and package-agnostic. A scaffold skill is added. The line-cut skills are retired.
- Process documentation: `docs/gitflow.md`, `docs/ci/RELEASE-TRAIN.md`, `CONTRIBUTING.md`, the site's README and `docs-workflow.md`.
- Dependencies: `fumadocs-openapi`. TypeDoc stays.
