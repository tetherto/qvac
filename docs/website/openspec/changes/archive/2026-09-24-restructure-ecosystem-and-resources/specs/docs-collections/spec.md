## MODIFIED Requirements

### Requirement: SDK collection composition inside its lines

The `sdk` collection SHALL hold the material about installing, configuring, and using the SDK, and MUST receive every existing page not claimed by another collection. The former `introduction.mdx` MUST become the collection overview. Because the collection is versioned, those pages MUST live inside a documentation-line folder rather than directly under the collection, and the API reference and release notes MUST keep only their current series, since the patch-series archives are superseded by the line model and belong to the Software Inventory. The collection MUST NOT document the CLI, which is released on its own package and documented in its own collection. It MUST hold the page describing what happens under the hood when an application uses the SDK, in every line, because that page documents the software this collection is about. It MUST NOT hold material that does not vary by release: the tutorials and the help material belong to `resources`, and MUST be absent from every line rather than present in each.

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

The `resources` collection SHALL NOT be versioned, and MUST therefore be the home of the material that supports the products without documenting a release of one. Its pages sit directly under the collection rather than inside a documentation line, and MUST NOT be copied into one when a line is cut. It MUST hold the tutorials and the help material the SDK gives up, and the page on building with AI, which is named for what a reader wants to do rather than for the protocol it describes.

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
- **THEN** the former Corpus protocol page is published as Build with AI, at `/resources/build-with-ai`
- **AND** its sidebar label, its page title, and its URL all carry the new name

#### Scenario: The overview describes the scope the collection has

- **WHEN** the Resources overview is read
- **THEN** it describes the material the collection now holds
- **AND** it offers the Recipes section of the main website in place of the former undifferentiated link to it

### Requirement: Ecosystem collection composition

The `ecosystem` collection SHALL hold what QVAC publishes: the Software Inventory of the released packages and the add-on catalogue, entered from an overview. It MUST NOT hold material that documents no distributable, so the project's vision and its launch announcement leave the published set rather than moving with it, and the page on how the SDK works moves to the SDK. Retiring a page from this collection does not put its subject out of reach: where the subject is published elsewhere, the collection MUST reach it by a departure rather than by holding a page for it.

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

#### Scenario: The retired vision is reachable where it is published

- **WHEN** the Ecosystem sidebar is read
- **THEN** it offers the project's vision as a departure to the main website
- **AND** no page for it is restored to this collection
