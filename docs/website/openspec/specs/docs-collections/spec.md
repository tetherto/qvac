## Purpose

The collection model of the documentation site. Which collections exist, the rule that a collection is a single top-level content folder owning a URL namespace, which pages belong to which collection, and the constraint that the reorganization into collections authored no new content beyond two declared exceptions.
## Requirements
### Requirement: Content is partitioned into collections

The documentation content SHALL be partitioned into collections, and every collection MUST own the URL namespace formed by its name.

- An unversioned collection's content MUST live in its folder under `docs/website/content/docs/`.
- A versioned collection's content MUST live in its package's `docs/users/` folder and be materialized per line.

Every published page MUST belong to exactly one collection.

#### Scenario: Every published page belongs to a collection

- **WHEN** the built page set is enumerated
- **THEN** every page resolves under exactly one collection

#### Scenario: A collection owns its URL namespace

- **WHEN** a page belonging to collection `<collection>` is requested
- **THEN** its URL starts with `/<collection>/`

#### Scenario: Versioned content lives with its package

- **WHEN** the SDK collection's source is located
- **THEN** it is `packages/sdk/docs/users/`, and nothing under `docs/website/content/docs/sdk/` is published

### Requirement: Collections introduced by this change

The site SHALL provide two unversioned collections, `ecosystem` and `resources`, and one versioned root collection per product, declared by a versions file of kind `product`. Today the versioned collections are `sdk` and `cli`. The collection set MUST NOT depend on how many products exist.

Research and the assistant app MUST be reached as departures rather than as collections. A collection MUST be named after what it holds.

#### Scenario: Only the agreed collections exist

- **WHEN** the collections are listed
- **THEN** they are exactly `ecosystem`, `resources`, and one collection per versions file of kind `product`

#### Scenario: Research and the assistant app are departures

- **WHEN** the navigation is read
- **THEN** Research leads to the project's model and dataset hub, the assistant app leads to its own site, and neither is a collection

### Requirement: SDK collection composition inside its lines

The `sdk` collection SHALL hold the material about installing, configuring, and using the SDK, and MUST receive every existing page not claimed by another collection. The former `introduction.mdx` MUST become the collection overview. Because the collection is versioned, those pages MUST live inside a documentation-line folder rather than directly under the collection, and the API reference MUST keep only its current series, since the patch-series archives are superseded by the line model and belong to the Software Inventory. Release notes MUST NOT be published as a page: each line's sidebar entry SHALL be an external link to that minor's GitHub release. The collection MUST NOT document the CLI, which is released on its own package and documented in its own collection. It MUST hold the page describing what happens under the hood when an application uses the SDK, in every line, because that page documents the software this collection is about. It MUST NOT hold material that does not vary by release: the tutorials and the help material belong to `resources`, and MUST be absent from every line rather than present in each.

#### Scenario: Introduction becomes the SDK overview

- **WHEN** the `sdk` collection is enumerated
- **THEN** it contains an overview page whose content is the former `introduction.mdx`

#### Scenario: SDK receives the remaining existing pages

- **WHEN** a documentation line of the `sdk` collection is enumerated
- **THEN** it contains the former `system-requirements.mdx`, plus `js-ts-sdk.mdx` and `python-sdk.mdx`, the per-client pages that absorbed the former `quickstart.mdx` and `installation.mdx`
- **AND** it contains the former `configuration/**`, `models/**`, `ai-capabilities/**`, `p2p-capabilities/**`, and `runtime/**` pages
- **AND** it contains the former `reference/api/index.mdx` and `reference/release-notes/index.mdx`

#### Scenario: The SDK no longer documents the CLI

- **WHEN** a documentation line of the `sdk` collection is enumerated
- **THEN** it contains no CLI page
- **AND** the collection's declared navigation offers no CLI entry

#### Scenario: The SDK holds the page on how it works

- **WHEN** a documentation line of the `sdk` collection is enumerated
- **THEN** it contains the former `about/how-it-works.mdx`
- **AND** the line's overview reaches it without leaving the collection

#### Scenario: Every SDK page sits inside a line

- **WHEN** the `sdk` collection folder is enumerated
- **THEN** every page under it sits inside a documentation-line folder

#### Scenario: The patch-series archives leave the published set

- **WHEN** the former `reference/api/v*.mdx` and `reference/release-notes/v*.mdx` pages are enumerated
- **THEN** none of them is published
- **AND** each is retained unpublished, with its former URL redirecting to the current series

#### Scenario: The tutorials and the help material leave every line

- **WHEN** any documentation line of the `sdk` collection is enumerated
- **THEN** it contains no `tutorials/**` page and no `troubleshooting.mdx`
- **AND** its declared navigation offers neither a tutorials section nor a help section

#### Scenario: An older line gives them up too

- **WHEN** the oldest published line of the `sdk` collection is enumerated
- **THEN** it holds no copy of the migrated pages, because they never varied by release

### Requirement: Resources holds the unversioned supporting material

The `resources` collection SHALL NOT be versioned, and MUST therefore be the home of the material that supports the products without documenting a release of one. Its pages sit directly under the collection rather than inside a documentation line, and MUST NOT be copied into one when a line is cut. It MUST hold the tutorials and the help material the SDK gives up, and the page telling an AI agent how to pick the documentation matching a release, which is named for the documentation it describes rather than for the activity of building with AI — an activity the SDK's own pages document.

#### Scenario: Resources holds unversioned supporting material

- **WHEN** the `resources` collection is enumerated
- **THEN** it contains its index page alongside the supporting pages, and no documentation-line folder

#### Scenario: Solutions are published unversioned

- **WHEN** a Solutions page is published
- **THEN** it resolves under `/resources/solutions/` with no version segment
- **AND** cutting a line in any collection leaves it untouched

#### Scenario: Resources receives the tutorials and the help material

- **WHEN** the `resources` collection is enumerated
- **THEN** it contains the former `sdk/<line>/tutorials/**` pages and the former `sdk/<line>/troubleshooting.mdx`
- **AND** each sits directly under the collection, in one copy

#### Scenario: The Corpus protocol page is renamed for what it lets a reader do

- **WHEN** the `resources` collection is enumerated
- **THEN** the former Corpus protocol page is published as Docs for AI agents, at `/resources/docs-for-ai-agents`
- **AND** its sidebar label, its page title, and its URL all carry that name
- **AND** the name describes the documentation rather than the activity of building with AI, which the SDK's own pages document

#### Scenario: The overview describes the scope the collection has

- **WHEN** the Resources overview is read
- **THEN** it describes the material the collection now holds
- **AND** it offers the Recipes section of the main website in place of the former undifferentiated link to it

### Requirement: CLI collection composition

The `cli` collection SHALL hold the material about installing and using `@qvac/cli`, the whole tool rather than one of its features. It MUST be composed from the CLI page the SDK collection gives up, which becomes the collection overview, and the HTTP-server pages, which document the model provider as one of the tool's functions. Because the collection is versioned, those pages MUST live inside a documentation-line folder rather than directly under the collection.

#### Scenario: The CLI page becomes the collection overview

- **WHEN** a documentation line of the `cli` collection is enumerated
- **THEN** its index is the former `sdk/<line>/cli.mdx`, covering installation, the command reference, and each function of the tool

#### Scenario: The CLI collection holds the HTTP-server pages

- **WHEN** a documentation line of the `cli` collection is enumerated
- **THEN** it contains the HTTP-server index, connection, and integration pages
- **AND** they are reached from the overview rather than from a second overview of their own

#### Scenario: Every CLI page sits inside a line

- **WHEN** the `cli` collection folder is enumerated
- **THEN** every page under it sits inside a documentation-line folder

#### Scenario: CLI sections without existing content are not authored

- **WHEN** the `cli` collection is enumerated
- **THEN** it contains no page for the anticipated Configuration, API reference, or Troubleshooting sections, because no existing page covers them

### Requirement: Ecosystem collection composition

The `ecosystem` collection SHALL hold what describes QVAC as a whole, entered from an overview. It SHALL also hold the Packages section that documents the internal packages, once at least one package is listed. It MUST NOT hold a product collection's guidance. Where a subject is published elsewhere, the collection MUST reach it by a departure.

#### Scenario: Ecosystem holds the overview and Packages

- **WHEN** the `ecosystem` collection is enumerated while at least one package is listed
- **THEN** it contains an overview and the Packages section

#### Scenario: Packages is absent while no package is listed

- **WHEN** no versions file of kind `platform` exists
- **THEN** the `ecosystem` collection contains no Packages section, and no navigation entry names it

#### Scenario: Product guidance stays in its collection

- **WHEN** an Ecosystem page touches a topic a product collection documents
- **THEN** it links to that collection instead of restating it
