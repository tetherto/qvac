## MODIFIED Requirements

### Requirement: Sidebar scoped to the active collection

The sidebar SHALL show the pages of the active collection, and MUST NOT surface another collection's tree: no page of another collection may appear in it by virtue of belonging to that collection's navigation. A sidebar MAY additionally carry departures — entries declared one by one, whose target is another collection, a single page inside another collection, or an address off the site. A departure MUST be declared deliberately in the collection's own navigation, never inherited, and MUST NOT be marked active, because following one leaves the collection. In a versioned collection the sidebar MUST be scoped to the active documentation line as well, so no entry crosses into another line.

#### Scenario: Only the active collection's pages are listed

- **WHEN** a page belonging to collection `<collection>` is rendered
- **THEN** every sidebar entry either resolves to a page in `<collection>` or is a declared departure
- **AND** no other collection's navigation contributes an entry

#### Scenario: Only the active line's pages are listed

- **WHEN** a page belonging to documentation line `<line>` is rendered
- **THEN** every sidebar entry that is not a departure resolves to a page in `<line>`

#### Scenario: The sidebar changes with the collection

- **WHEN** the reader navigates from a page in one collection to a page in another
- **THEN** the sidebar is replaced by the destination collection's tree

#### Scenario: The sidebar changes with the line

- **WHEN** the reader switches documentation line
- **THEN** the sidebar is replaced by the destination line's tree

#### Scenario: Following a departure hands the reader to the destination

- **WHEN** the reader activates a departure pointing into another collection
- **THEN** the destination page renders under its own collection's sidebar and its own collection's tab

#### Scenario: A departure off the site is marked as leaving

- **WHEN** a departure whose target is not on this site is rendered
- **THEN** it is presented as an outbound link rather than as a page of this collection

### Requirement: Navigation is validated against content for every collection

The existing check that every sidebar URL resolves to a content file SHALL cover every collection's tree, and in a versioned collection every published line of it. A sidebar entry pointing at a page that does not exist MUST fail the check, in any collection and any line, whether the entry was declared in the site source or in a line's own folder. An entry present in one line and absent from another MUST NOT fail the check on that ground alone. A departure into another collection MUST be checked like any other entry, because a page backs it. A departure off the site MUST be exempt, because no content file can back it and the check has no way to reach it.

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

#### Scenario: A departure into another collection is checked

- **WHEN** a collection declares a departure pointing at a page in another collection
- **THEN** the check requires that page to exist, and fails if it does not

#### Scenario: A departure off the site is not checked against content

- **WHEN** a collection declares a departure whose target is off the site
- **THEN** the check skips it rather than demanding a content file for it

## ADDED Requirements

### Requirement: A departure does not shadow its target's own navigation

A collection's sidebar is also the structure the site resolves a page's own collection against: the roots are searched in declaration order and the first page node matching the pathname decides which root, and therefore which sidebar, the page is rendered under. A departure pointing into another collection SHALL therefore be declared in a form that cannot be matched as a page of the collection declaring it. Following a departure MUST leave the destination page under its own collection's sidebar and tab, whatever order the collections are declared in.

#### Scenario: A collection's landing page keeps its own sidebar

- **WHEN** a collection's landing page is rendered, and an earlier-declared collection carries a departure pointing at it
- **THEN** it renders under its own collection's sidebar, not the declaring collection's

#### Scenario: A page targeted by a departure keeps its own sidebar

- **WHEN** a single page inside a collection is the target of another collection's departure
- **THEN** that page renders under its own collection's sidebar

#### Scenario: The shadowing guard is enforced by a check

- **WHEN** a departure is rewritten into a form that the resolution would match
- **THEN** a check fails and names the page whose sidebar the departure would capture

### Requirement: The Ecosystem sidebar maps what QVAC publishes

The Ecosystem sidebar SHALL present what the project publishes, whether or not this site documents it, grouped under separators. Above the groups it MUST offer the collection overview and the project's vision. It MUST carry a Products group reaching the SDK collection, the CLI collection, the page inside the CLI that documents using it as a model provider, and the assistant app. It MUST carry a Platform group reaching Fabric, the add-on catalogue, and the Software Inventory. It MUST carry a Research group reaching the model family and the datasets. An entry whose subject this site does not document MUST be a departure to where it is documented, rather than a page written to stand in for one.

#### Scenario: The sidebar is grouped under the three separators

- **WHEN** the Ecosystem sidebar is rendered
- **THEN** its entries appear under the Products, Platform, and Research separators, in that order
- **AND** the overview and the vision appear above the first separator

#### Scenario: Products reaches the products

- **WHEN** the Products group is read
- **THEN** it offers the SDK collection, the CLI collection, the model-provider page inside the CLI, and the assistant app

#### Scenario: Platform reaches the platform

- **WHEN** the Platform group is read
- **THEN** it offers Fabric, the add-on catalogue, and the Software Inventory

#### Scenario: Research reaches the research

- **WHEN** the Research group is read
- **THEN** it offers the model family and the datasets

#### Scenario: An undocumented subject is linked, not written

- **WHEN** an entry names something this site holds no page for
- **THEN** it is a departure to where that subject is published
- **AND** no page is authored in this collection to stand in for it

### Requirement: The Resources sidebar holds what belongs to no release

The Resources sidebar SHALL list the material that supports the products without documenting a release of one: the collection overview, the page on building with AI, the tutorials, and the help material. The tutorials and the help material MUST appear here rather than in any versioned collection, and MUST NOT be duplicated into one.

#### Scenario: Resources lists the migrated sections

- **WHEN** the Resources sidebar is rendered
- **THEN** it offers the overview, the Build with AI page, the tutorials, and the help material

#### Scenario: The migrated sections appear in no versioned collection

- **WHEN** the sidebar of any documentation line of a versioned collection is rendered
- **THEN** it offers no tutorials section and no help section
