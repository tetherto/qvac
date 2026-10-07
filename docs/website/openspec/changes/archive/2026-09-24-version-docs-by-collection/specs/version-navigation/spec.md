## ADDED Requirements

### Requirement: The line switcher sits at the top of the sidebar

Every page of a versioned collection SHALL offer a documentation-line switcher in the sidebar header, below whatever controls that header already carries and above the collection's navigation tree, so it reads as a property of the tree below it rather than of the page. The control MUST be the same one the sidebar already uses to switch collection, configured with the lines instead of the collections, so the two read as one mechanism at two scopes and neither carries styling of its own. It MUST list the collection's published lines and show the active one as its label. A line SHALL be labelled `v<major>.<minor>`, with the current line carrying the ` (latest)` suffix. It SHALL serve the inventory's packages on the same terms, which the inventory capability states. A page that documents no versioned software MUST NOT show it.

#### Scenario: A versioned page offers the switcher

- **WHEN** an SDK page is rendered
- **THEN** the line switcher is the last element of the sidebar header, directly above the navigation tree
- **AND** its label names the line the reader is on

#### Scenario: Narrow viewports order the two switchers

- **WHEN** an SDK page is rendered on a viewport where the collection bar has collapsed into its control
- **THEN** the sidebar header shows the collection control first and the line switcher after it
- **AND** the navigation tree follows both

#### Scenario: The switcher matches the collection control

- **WHEN** the switcher is rendered
- **THEN** it is the sidebar's collection control rendered over the lines
- **AND** no styling, navigation, or active-state logic is written for the switcher alone

#### Scenario: The switcher lists the collection's lines

- **WHEN** the switcher is opened on an SDK page and `v0.19` is the current line
- **THEN** it lists `v0.19 (latest)` and `v0.18`
- **AND** exactly one entry carries the suffix

#### Scenario: The trigger carries the same label

- **WHEN** the reader is on a page of the current line
- **THEN** the switcher's trigger reads `v0.19 (latest)`

#### Scenario: The suffix follows the cut

- **WHEN** a cut makes another line current
- **THEN** the suffix moves to it, and no other entry carries one

#### Scenario: Unversioned pages have no switcher

- **WHEN** a Platform page outside the inventory, or a Resources page, is rendered
- **THEN** no line switcher appears above the navigation tree

#### Scenario: The switcher ships no per-page data to the browser

- **WHEN** the switcher is rendered
- **THEN** the only version data it carries is the published lines of each versioned collection and the versions of each inventory package
- **AND** the destination of a selection is derived from the current path rather than from a per-page table

### Requirement: Selecting a line switches the whole context

Selecting a line SHALL move the reader into that line entirely. The page, the sidebar, the canonical URL, the Markdown URL, and the retrieval scope MUST all belong to the selected line after the switch, and no surface may keep serving the previous one.

#### Scenario: Switching moves every surface

- **WHEN** the reader switches from `v0.19` to `v0.18`
- **THEN** the page, sidebar, canonical URL, Markdown URL, and retrieval scope are all `v0.18`

#### Scenario: Switching does not cross collections

- **WHEN** the reader switches lines on an SDK page
- **THEN** the destination is an SDK page

### Requirement: Switching is a client-side navigation, not a page reload

Switching lines SHALL be a client-side navigation. The document MUST NOT be reloaded, and the surfaces that do not depend on the line — the navbar, the collection bar, and the sidebar container — MUST persist across the switch rather than being torn down and rebuilt. Only what belongs to the line may change.

#### Scenario: The document is not reloaded

- **WHEN** the reader switches lines
- **THEN** the browser performs a client-side navigation
- **AND** no full document load occurs

#### Scenario: The shell persists

- **WHEN** the reader switches lines
- **THEN** the navbar, the collection bar, and the sidebar container are not remounted
- **AND** the reader sees no blank or unstyled intermediate state

#### Scenario: The destination is prefetched like any other link

- **WHEN** the switcher's options are presented
- **THEN** each behaves as a link the router can prefetch, rather than a scripted location assignment

### Requirement: The equivalent page is resolved by path

Switching lines SHALL land on the page occupying the same path within the target line. Equivalence MUST be positional, so a page that keeps its path across lines is always reachable by switching.

#### Scenario: The same path resolves in the target line

- **WHEN** the reader switches from `/sdk/guides/streaming/` to `v0.18`
- **THEN** the destination is `/sdk/v0.18/guides/streaming/`

#### Scenario: Switching back returns to the origin

- **WHEN** the reader switches to another line and back, and the page exists in both
- **THEN** the reader is on the page they started from

### Requirement: A page absent from the target line falls back to its index

When the path does not exist in the target line, the switcher SHALL land on that line's index. It MUST NOT 404, and MUST NOT stay on the current page. The index is served as itself, with no notice about the page that was asked for.

#### Scenario: A missing page lands on the line index

- **WHEN** the reader switches to `v0.18` from a page that line does not contain
- **THEN** the destination is the index of the SDK `v0.18` line

#### Scenario: The index is served unchanged

- **WHEN** the fallback is taken
- **THEN** the destination is the ordinary line index, with no message about the requested page

### Requirement: Navigation between lines is validated at build time

Every switcher destination SHALL be checked at build time. A destination that resolves to neither an existing page nor the target line's index MUST fail the build.

#### Scenario: A broken destination fails the build

- **WHEN** a switcher destination resolves to no published URL
- **THEN** the build fails and names the source page and target line
