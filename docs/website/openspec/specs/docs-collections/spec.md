## Purpose

The collection model of the documentation site. Which collections exist, the rule that a collection is a single top-level content folder owning a URL namespace, which pages belong to which collection, and the constraint that the reorganization into collections authored no new content beyond two declared exceptions.
## Requirements
### Requirement: Content is partitioned into collections

The documentation content SHALL be partitioned into collections. Each collection MUST be a single top-level folder under `content/docs`, and MUST own the URL namespace formed by its folder name. Every published page MUST belong to exactly one collection, so no page is reachable from two collections and no page sits outside a collection.

#### Scenario: Every published page belongs to a collection

- **WHEN** the content tree under `content/docs` is enumerated
- **THEN** every `.mdx` file resolves under exactly one top-level collection folder
- **AND** no `.mdx` file remains directly at the root of `content/docs`

#### Scenario: A collection owns its URL namespace

- **WHEN** a page belonging to collection `<collection>` is requested
- **THEN** its URL starts with `/<collection>/`

### Requirement: Collections introduced by this change

The site SHALL provide exactly four collections: `ecosystem`, `sdk`, `cli`, and `resources`. The `app` and `research` collections anticipated by the target information architecture MUST NOT be created by this change. A collection MUST be named after what it holds, so a collection is renamed when what it holds changes.

#### Scenario: Only the four agreed collections exist

- **WHEN** the top-level folders under `content/docs` are listed
- **THEN** they are exactly `ecosystem`, `sdk`, `cli`, and `resources`

#### Scenario: Deferred collections are absent

- **WHEN** the content tree is enumerated
- **THEN** no `app` or `research` collection folder exists

#### Scenario: No collection is named after a feature of the package it tracks

- **WHEN** a versioned collection's name is compared with the package its lines follow
- **THEN** the name identifies that package rather than one of the things it does

### Requirement: SDK collection composition inside its lines

The `sdk` collection SHALL hold the material about installing, configuring, and using the SDK, and MUST receive every existing page not claimed by another collection. The former `introduction.mdx` MUST become the collection overview. Because the collection is versioned, those pages MUST live inside a documentation-line folder rather than directly under the collection, and the API reference and release notes MUST keep only their current series, since the patch-series archives are superseded by the line model and belong to the Software Inventory. The collection MUST NOT document the CLI, which is released on its own package and documented in its own collection. It MUST hold the page describing what happens under the hood when an application uses the SDK, in every line, because that page documents the software this collection is about.

#### Scenario: Introduction becomes the SDK overview

- **WHEN** the `sdk` collection is enumerated
- **THEN** it contains an overview page whose content is the former `introduction.mdx`

#### Scenario: SDK receives the remaining existing pages

- **WHEN** a documentation line of the `sdk` collection is enumerated
- **THEN** it contains the former `system-requirements.mdx` and `troubleshooting.mdx`, plus `js-ts-sdk.mdx` and `python-sdk.mdx`, the per-client pages that absorbed the former `quickstart.mdx` and `installation.mdx`
- **AND** it contains the former `configuration/**`, `models/**`, `ai-capabilities/**`, `p2p-capabilities/**`, `runtime/**`, and `tutorials/**` pages
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

### Requirement: Resources holds the unversioned supporting material

The `resources` collection SHALL NOT be versioned, and MUST therefore be the home of the material that supports the products without documenting a release of one. Its pages sit directly under the collection rather than inside a documentation line, and MUST NOT be copied into one when a line is cut.

#### Scenario: Resources holds unversioned supporting material

- **WHEN** the `resources` collection is enumerated
- **THEN** it contains its index page alongside the supporting pages, and no documentation-line folder

#### Scenario: Solutions are published unversioned

- **WHEN** a Solutions page is published
- **THEN** it resolves under `/resources/solutions/` with no version segment
- **AND** cutting a line in any collection leaves it untouched

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

The `ecosystem` collection SHALL hold what QVAC publishes: the Software Inventory of the released packages and the add-on catalogue, entered from an overview. It MUST NOT hold material that documents no distributable, so the project's vision and its launch announcement leave the published set rather than moving with it, and the page on how the SDK works moves to the SDK.

#### Scenario: Ecosystem receives the site index as its overview

- **WHEN** the `ecosystem` collection is enumerated
- **THEN** it contains an overview page whose content is the former `content/docs/index.mdx`

#### Scenario: Ecosystem holds the inventory and the add-ons, and nothing else

- **WHEN** the `ecosystem` collection is enumerated
- **THEN** it contains the Software Inventory and the add-on pages nested under it
- **AND** it contains no `about/` section

#### Scenario: The vision and the launch announcement are retired

- **WHEN** the former `about/vision.mdx` and `about/public-launch.mdx` are enumerated
- **THEN** neither is published
- **AND** each is retained unpublished, with its former URL redirecting to the collection overview

