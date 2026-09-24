# software-inventory-docs Specification

## Purpose
TBD - created by archiving change version-docs-by-collection. Update Purpose after archive.
## Requirements
### Requirement: Each package is entered at an index that lists its versions

Each inventory entry SHALL be reachable at a version-less path serving an index page for the package itself, not a version of it. That page MUST carry the package's published name, one sentence stating what the package is, a link to its repository and to its registry listing, and the list of versions the site documents, each linking that version's page and its GitHub release. Every version page, including the newest, MUST be addressed at a versioned path, so no inventory URL changes what it serves when a release happens. The Software Inventory index MUST list every documented package by its published name and link it to that package's index.

#### Scenario: The package path serves the index

- **WHEN** `/ecosystem/inventory/cli/` is requested
- **THEN** the package index is served, listing the documented versions
- **AND** no README is served at that path

#### Scenario: The newest version is addressed like any other

- **WHEN** the newest documented version of a package is requested
- **THEN** its path carries the version segment, exactly as an older one does

#### Scenario: Documenting a release changes no existing URL

- **WHEN** a new version is documented
- **THEN** every existing version URL still serves what it served
- **AND** the package index gains one entry

#### Scenario: The inventory index lists the packages

- **WHEN** the Software Inventory index is rendered
- **THEN** it lists each documented package by its published name and links to that package's index

#### Scenario: An index that disagrees with the manifest fails the build

- **WHEN** a package index links a version the manifest does not declare, or omits one it does
- **THEN** the build fails and names the package and the version

### Requirement: A package's versions are folders, and none of them is a folder group

Each documented version SHALL be one folder named `v<major>.<minor>` under its package's folder, and no folder group SHALL be used anywhere in the inventory, because the version-less path belongs to the package index. The rules that govern a versioned collection's folder group therefore do not apply here, and the inventory publishes no current line. A version folder MUST NOT carry a patch component. The number MUST be the major and minor the package publishes under, which for a package whose version is stamped from another package is that other package's number.

#### Scenario: Every version is an explicit folder

- **WHEN** a package entry is enumerated
- **THEN** it has one folder per documented version, and none of them is a folder group

#### Scenario: Patch-shaped version folders are rejected

- **WHEN** the content tree is validated
- **THEN** a folder named `v0.13.0` or `v0.13.x` under a package fails the check

#### Scenario: Packages version independently

- **WHEN** two packages of the same product are documented
- **THEN** each carries the version numbers it publishes under, which need not match

### Requirement: A package's versions are moved between with the switcher

A package's pages SHALL offer the same switcher a versioned collection's lines use, listing the package's index alongside every version it publishes and showing the reader's own as its label. The index is listed because it is where a package is entered and no version is served version-less: without it the control would have nothing selected on the page the reader arrives at, and would not appear at all. The inventory's sidebar entries SHALL be one per package, entered at its index, and none per version — the sidebar carries the inventory's shape and the switcher carries the version. The package index SHALL still enumerate the versions, and every version page MUST link back to it.

#### Scenario: A package page offers the switcher

- **WHEN** a package index or version page is rendered
- **THEN** the switcher is offered above the navigation tree, as on a versioned collection's page
- **AND** its label reads the version being read, or `All versions` on the index

#### Scenario: The switcher lists the index and every version

- **WHEN** the switcher is opened on a package documented at `v0.19` and `v0.18`
- **THEN** it lists `All versions`, `v0.19`, and `v0.18`
- **AND** no entry carries the ` (latest)` suffix, which the inventory does not use

#### Scenario: No version appears in the sidebar

- **WHEN** the inventory's entries are rendered
- **THEN** each package appears once, at its index

#### Scenario: A version page keeps its collection's sidebar

- **WHEN** a package version page is rendered
- **THEN** the sidebar is the navigation of the collection the inventory sits in, with the inventory open
- **AND** it is never the fallback listing of collections a page absent from the navigation tree would produce

#### Scenario: Every version page returns to the index

- **WHEN** a package version page is rendered
- **THEN** it links to its package's index

### Requirement: A version page is the package README as released

A version's only page SHALL be the package's `README.md` as it stood at the release that version covers, published in full. No content is written for it or summarized from it. Nothing documentary may be dropped; repository chrome that documents nothing — a badge banner, a table of contents the site renders itself — MAY be. The page MUST be published as Markdown rather than MDX, so the file needs no adaptation to be publishable, and MUST record which tag it came from.

#### Scenario: A version page is the README, whole

- **WHEN** a package version page is rendered
- **THEN** it shows that package's README as released, with every documentary section intact

#### Scenario: The README needs no adaptation

- **WHEN** a README carries HTML, braces, or anything else MDX would reject
- **THEN** it is published anyway, because the page is Markdown

#### Scenario: The source is the tag

- **WHEN** a version page is published
- **THEN** its content is the package's `README.md` at that release's tag, and the page names that tag

### Requirement: An inventory page carries no repository-relative link

A README is written for someone standing in the repository, so a published inventory page MUST NOT carry a link that only resolves there. Every such link SHALL point at GitHub on that version's tag instead. In-page anchors MUST be left alone.

#### Scenario: A repository-relative link points at GitHub

- **WHEN** a published page would otherwise link `./e2e/README.md` or `../bare-sdk/README.md`
- **THEN** it links the same file on GitHub at that version's tag

#### Scenario: Anchors are untouched

- **WHEN** a README links `#configuration`
- **THEN** the published page keeps the anchor as written

### Requirement: The inventory covers the SDK, Python, CLI, and provider packages

This change SHALL publish inventory entries for `@qvac/sdk`, the Python client, `@qvac/cli`, and `@qvac/ai-sdk-provider`. Each MUST carry its two most recent released versions. A package with only one release published SHALL carry one version, and MUST gain its second at its next minor release with no new structure.

#### Scenario: A package with two releases carries two versions

- **WHEN** a package has published two or more minor releases
- **THEN** its entry documents the two most recent, both listed on its index

#### Scenario: A package with one release carries one version

- **WHEN** a package has published only one release
- **THEN** its index lists one version, and nothing about the entry differs otherwise

#### Scenario: The Python client tracks the SDK's numbers

- **WHEN** the Python client's versions are enumerated
- **THEN** they carry the SDK's numbers, because its version is stamped from the SDK

### Requirement: Exact releases defer to GitHub Releases

The inventory SHALL NOT restate per-patch release detail. A version page MUST link the GitHub release it was taken from, and MUST NOT reproduce release notes or changelogs.

#### Scenario: A version page links its release

- **WHEN** a package version page is rendered
- **THEN** it links the GitHub release matching its tag

#### Scenario: Patch detail is not duplicated

- **WHEN** a patch release is published
- **THEN** the inventory requires no page edit

### Requirement: The Software Inventory documents packages and is entered from Ecosystem

The Ecosystem collection SHALL contain a Software Inventory that documents the published packages themselves. A collection documents a product — what it is for and how to build with it — while an inventory entry documents one distributable: what the package is, how to install it, how to use it, and what its API surface is. The same product MAY be delivered by several packages, and each MUST get its own entry.

#### Scenario: The inventory is entered from Ecosystem

- **WHEN** the Ecosystem collection is browsed
- **THEN** the Software Inventory is reachable from it, and it lists the documented packages

#### Scenario: One entry per package

- **WHEN** a product is delivered by several packages
- **THEN** the inventory contains one entry per package, each named by its published package name

#### Scenario: Inventory and collection do not duplicate each other

- **WHEN** an inventory entry and a product collection both cover a topic
- **THEN** the inventory entry documents the package surface and links to the collection for product guidance, instead of restating it

