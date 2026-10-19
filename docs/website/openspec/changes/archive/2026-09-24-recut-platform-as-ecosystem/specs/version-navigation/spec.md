## MODIFIED Requirements

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

- **WHEN** an Ecosystem page outside the inventory, or a Resources page, is rendered
- **THEN** no line switcher appears above the navigation tree

#### Scenario: The switcher ships no per-page data to the browser

- **WHEN** the switcher is rendered
- **THEN** the only version data it carries is the published lines of each versioned collection and the versions of each inventory package
- **AND** the destination of a selection is derived from the current path rather than from a per-page table
