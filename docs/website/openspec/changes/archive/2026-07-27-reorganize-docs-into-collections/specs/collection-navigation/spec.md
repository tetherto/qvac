## ADDED Requirements

### Requirement: Collection bar as a second navigation level

The site SHALL present a second level of navigation, below the existing top navbar, listing every collection. On viewports wide enough for it, this level MUST take the form of a horizontal bar. On narrower viewports, where a row of entries would not fit, it MAY collapse into a single control that opens the same list. In either form it MUST be reachable from every documentation page, MUST indicate which collection the current page belongs to, and each entry MUST navigate to that collection's landing page.

#### Scenario: The bar lists every collection

- **WHEN** a documentation page is rendered on a viewport wide enough for the bar
- **THEN** the second-level bar lists Platform, SDK, Provider, and Resources

#### Scenario: Narrow viewports collapse the level into a control

- **WHEN** a documentation page is rendered on a viewport too narrow for the bar
- **THEN** the collection list is reachable from a single control in the navigation
- **AND** that list names the same collections and marks the same one active

#### Scenario: The active collection is indicated

- **WHEN** a page belonging to collection `<collection>` is rendered
- **THEN** the `<collection>` entry in the bar is marked active
- **AND** no other entry is marked active

#### Scenario: Switching collection

- **WHEN** the reader activates a collection entry other than the active one
- **THEN** the browser navigates to that collection's landing page
- **AND** the sidebar then shows that collection's pages

#### Scenario: The first navbar keeps its existing items

- **WHEN** a documentation page is rendered
- **THEN** the existing top navbar still offers the logo linking to the docs home, search, the AI assistant, the For AI entry, the main website link, and the social and repository links

### Requirement: Collection entries share the sidebar's hover and active treatment

The hover and active states of a collection entry SHALL reuse the colour treatment the sidebar already applies to its own items, so the two navigation surfaces read as one system rather than two. The states MUST come from the same design tokens the sidebar uses, not from values redeclared for the bar. The bar MAY keep an active marker of its own, since the two surfaces mark the active entry differently — a bar has a baseline to underline, a vertical list does not.

#### Scenario: Hovering a collection entry

- **WHEN** the pointer rests on a collection entry that is not active
- **THEN** its background shading matches what the sidebar applies to a hovered item

#### Scenario: The active collection entry

- **WHEN** a collection entry is the active one
- **THEN** it is drawn in the same colour the sidebar gives its active item
- **AND** it carries the bar's own active marker

#### Scenario: States are token-driven

- **WHEN** the styles behind these states are inspected
- **THEN** they resolve to the same tokens the sidebar items use
- **AND** no colour value is hardcoded for the collection bar alone

### Requirement: Sidebar scoped to the active collection

The sidebar SHALL show only the pages of the active collection. Pages of other collections MUST NOT appear in the sidebar, so that navigating within a collection never surfaces another collection's tree.

#### Scenario: Only the active collection's pages are listed

- **WHEN** a page belonging to collection `<collection>` is rendered
- **THEN** every sidebar entry resolves to a page in `<collection>`

#### Scenario: The sidebar changes with the collection

- **WHEN** the reader navigates from a page in one collection to a page in another
- **THEN** the sidebar is replaced by the destination collection's tree

### Requirement: Sidebar trees remain hand-authored

The navigation of every collection SHALL be declared explicitly in the site source, following the structure used by the current hand-authored tree, rather than being derived from the content directory layout. Section grouping within a collection MUST remain expressible, as it is today.

#### Scenario: Every collection's navigation is declared, not generated

- **WHEN** the site source is inspected
- **THEN** every collection's entries are explicitly declared there
- **AND** no part of the navigation is generated from the filesystem

### Requirement: Navigation is validated against content for every collection

The existing check that every sidebar URL resolves to a content file SHALL cover every collection's tree. A sidebar entry pointing at a page that does not exist MUST fail the check, in any collection.

#### Scenario: A dangling entry in any collection fails the check

- **WHEN** any collection's tree contains an entry whose target page does not exist
- **THEN** the sidebar consistency check fails and names the offending collection and URL

#### Scenario: All collections pass after the reorganization

- **WHEN** the sidebar consistency check runs against the reorganized site
- **THEN** it passes for all four collections
