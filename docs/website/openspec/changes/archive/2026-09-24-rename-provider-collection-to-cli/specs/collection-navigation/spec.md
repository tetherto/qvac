## MODIFIED Requirements

### Requirement: Collection bar as a second navigation level

The site SHALL present a second level of navigation, below the existing top navbar, listing every collection. On viewports wide enough for it, this level MUST take the form of a horizontal bar. On narrower viewports, where a row of entries would not fit, it MAY collapse into a single control that opens the same list. In either form it MUST be reachable from every documentation page, MUST indicate which collection the current page belongs to, and each entry MUST navigate to that collection's landing page. For a versioned collection, that landing page MUST be the index of its current documentation line.

#### Scenario: The bar lists every collection

- **WHEN** a documentation page is rendered on a viewport wide enough for the bar
- **THEN** the second-level bar lists Platform, SDK, CLI, and Resources

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

#### Scenario: The CLI entry reaches the whole tool

- **WHEN** the reader activates the CLI entry
- **THEN** the destination documents the tool as a whole, with the model provider reachable from it as one of its functions

#### Scenario: The first navbar keeps its existing items

- **WHEN** a documentation page is rendered
- **THEN** the existing top navbar still offers the logo linking to the docs home, search, the AI assistant, the For AI entry, the main website link, and the social and repository links
