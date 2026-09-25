# version-navigation Specification

## Purpose
What a reader is told about the documentation line they are on, and how they move to another. The switcher at the top of the sidebar, what selecting a line does to the rest of the page, how the equivalent page is resolved and what happens when the target line does not have it, the label on the breadcrumb row naming the release a page documents, and the gates that hold both against the built site.
## Requirements
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

### Requirement: A versioned page labels its release on the breadcrumb row

Every page of a versioned collection SHALL carry a label naming the documentation line it belongs to. The label MUST sit on the breadcrumb row, aligned to its right edge, and MUST read the line's version and nothing else — the collection is named to its left by the trail, and by the collection bar and the sidebar where there is no trail.

The label MUST appear on a page of a versioned collection that renders no trail, which is every collection index and every line index. On such a page the row holds the label alone.

#### Scenario: A page inside a documentation line is labelled

- **WHEN** a page of a versioned collection is rendered
- **THEN** the right of its breadcrumb row names that page's documentation line

#### Scenario: A versioned index with no trail is still labelled

- **WHEN** a collection index or a line index of a versioned collection is rendered
- **THEN** the row holds the label with no trail beside it

#### Scenario: An unversioned collection carries no label

- **WHEN** a page of a collection that publishes no documentation lines is rendered
- **THEN** it carries no label, and no row is rendered where it would have no trail either

#### Scenario: An inventory page carries no label

- **WHEN** a page cataloguing a release of an inventory package is rendered
- **THEN** it carries no label, because it catalogues a release rather than documenting a line

### Requirement: The label says whether the release is the current one

The label SHALL distinguish the current documentation line from every past one. The current line MUST be emphasised in the brand colour and every past line MUST be drawn neutrally, so a reader on outdated documentation is told so without reading.

Because colour alone cannot carry that meaning, the label's accessible name MUST state it in words. The version number alone does not say whether it is current, so a reader who cannot distinguish the two treatments MUST be given the standing as text.

#### Scenario: The current line is emphasised

- **WHEN** a page of the line served at the collection's version-less paths is rendered
- **THEN** its label is drawn in the brand colour

#### Scenario: A past line is neutral

- **WHEN** a page of a line other than the current one is rendered
- **THEN** its label is drawn neutrally, in the treatment shared by every past line

#### Scenario: The standing is available as text

- **WHEN** a label is read by assistive technology, or by anything that keeps only the page's text
- **THEN** it states in words whether the release is the current one

### Requirement: The label is a statement, not a control

The label SHALL offer no navigation. It MUST NOT be a link or a button. Changing line remains the switcher's job alone, so that one control answers "how do I change version" and the reader is never offered a second one that behaves differently.

#### Scenario: The label cannot be followed

- **WHEN** a labelled page is rendered
- **THEN** its label carries no link and no control

#### Scenario: Changing line stays with the switcher

- **WHEN** a reader on a past line wants the current release
- **THEN** the switcher is what takes them there, including from a page that line does not have

### Requirement: The breadcrumb row is asserted against the built pages

The row SHALL be checked against the rendered HTML, as one check covering both what it holds: a gate that located the row by its own rule for each would eventually disagree with the other about which element the row is.

The check MUST cover which pages carry a label, which carry none, that the label names the page's own line, that the current line and a past one are drawn differently, and that the standing is present as text. It MUST also assert that no versioned page's Markdown carries an injected statement of its release.

#### Scenario: A label naming the wrong line fails

- **WHEN** a built page's label names a line other than the page's own
- **THEN** the check fails and names the page

#### Scenario: A label on an unversioned page fails

- **WHEN** a built page of a collection publishing no lines carries a label
- **THEN** the check fails and names the page

#### Scenario: A reinjected sentence fails

- **WHEN** a built page's Markdown states its release in its prose
- **THEN** the check fails and names the page

