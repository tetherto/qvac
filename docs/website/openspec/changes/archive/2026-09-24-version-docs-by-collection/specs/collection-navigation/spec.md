## MODIFIED Requirements

### Requirement: Collection bar as a second navigation level

The site SHALL present a second level of navigation, below the existing top navbar, listing every collection. On viewports wide enough for it, this level MUST take the form of a horizontal bar. On narrower viewports, where a row of entries would not fit, it MAY collapse into a single control that opens the same list. In either form it MUST be reachable from every documentation page, MUST indicate which collection the current page belongs to, and each entry MUST navigate to that collection's landing page. For a versioned collection, that landing page MUST be the index of its current documentation line.

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

#### Scenario: A versioned collection lands on its current line

- **WHEN** the reader activates a versioned collection's entry from any line
- **THEN** the destination is that collection's current line, at its version-less path

#### Scenario: The first navbar keeps its existing items

- **WHEN** a documentation page is rendered
- **THEN** the existing top navbar still offers the logo linking to the docs home, search, the AI assistant, the For AI entry, the main website link, and the social and repository links

### Requirement: Sidebar scoped to the active collection

The sidebar SHALL show only the pages of the active collection. Pages of other collections MUST NOT appear in the sidebar, so that navigating within a collection never surfaces another collection's tree. In a versioned collection the sidebar MUST be scoped to the active documentation line as well, so no entry crosses into another line.

#### Scenario: Only the active collection's pages are listed

- **WHEN** a page belonging to collection `<collection>` is rendered
- **THEN** every sidebar entry resolves to a page in `<collection>`

#### Scenario: Only the active line's pages are listed

- **WHEN** a page belonging to documentation line `<line>` is rendered
- **THEN** every sidebar entry resolves to a page in `<line>`

#### Scenario: The sidebar changes with the collection

- **WHEN** the reader navigates from a page in one collection to a page in another
- **THEN** the sidebar is replaced by the destination collection's tree

#### Scenario: The sidebar changes with the line

- **WHEN** the reader switches documentation line
- **THEN** the sidebar is replaced by the destination line's tree

### Requirement: Sidebar trees remain declared, and a versioned line declares its own

The navigation of every collection SHALL be declared explicitly rather than inferred from the content directory layout, and section grouping within a collection MUST remain expressible, as it is today. An unversioned collection SHALL keep declaring its tree in the site source. A versioned collection SHALL declare each line's tree inside that line's own content folder, so that copying the folder copies the navigation, and each line MUST be able to order, group, add, and omit entries independently of every other line.

#### Scenario: Every collection's navigation is declared, not generated

- **WHEN** the site source and the content folders are inspected
- **THEN** every collection's entries and their order are explicitly declared in one place or the other
- **AND** no part of the navigation falls back to the directory layout's own ordering

#### Scenario: A line's navigation lives with its content

- **WHEN** a versioned collection's navigation is inspected
- **THEN** each line's entries are declared inside that line's content folder

#### Scenario: Cutting a line carries its navigation

- **WHEN** a line is cut by copying a line folder
- **THEN** the new line's sidebar matches the folder it was copied from, with no further declaration

#### Scenario: Lines may differ in structure

- **WHEN** one line orders, groups, or omits entries differently from another
- **THEN** each line's sidebar reflects its own declaration
- **AND** neither line's declaration is affected by the other

### Requirement: Navigation is validated against content for every collection

The existing check that every sidebar URL resolves to a content file SHALL cover every collection's tree, and in a versioned collection every published line of it. A sidebar entry pointing at a page that does not exist MUST fail the check, in any collection and any line, whether the entry was declared in the site source or in a line's own folder. An entry present in one line and absent from another MUST NOT fail the check on that ground alone.

#### Scenario: A dangling entry in any collection fails the check

- **WHEN** any collection's tree contains an entry whose target page does not exist
- **THEN** the sidebar consistency check fails and names the offending collection and URL

#### Scenario: A line naming a page it does not carry fails the check

- **WHEN** a line's own declaration names a page that is absent from that line
- **THEN** the check fails and names the line and the entry

#### Scenario: A page in one line only passes the check

- **WHEN** a page exists in one line and not in another, and only the first line lists it
- **THEN** the check passes

#### Scenario: All collections pass after the reorganization

- **WHEN** the sidebar consistency check runs against the reorganized site
- **THEN** it passes for all four collections, in every published line

## RENAMED Requirements

- FROM: `### Requirement: Sidebar trees remain hand-authored`
- TO: `### Requirement: Sidebar trees remain declared, and a versioned line declares its own`
