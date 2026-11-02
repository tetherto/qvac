## Purpose

How a reader moves between and within collections. The second-level collection bar, its visual relationship to the sidebar, the sidebar scoped to the active collection, the trail above a page that names where it sits, and the gate that keeps every collection's hand-authored navigation pointing at content that exists.
## Requirements
### Requirement: Collection bar as a second navigation level

The site SHALL present a second level of navigation, below the existing top navbar, listing every collection. On viewports wide enough for it, this level MUST take the form of a horizontal bar. On narrower viewports, where a row of entries would not fit, it MAY collapse into a single control that opens the same list. In either form it MUST be reachable from every documentation page, MUST indicate which collection the current page belongs to, and each entry MUST navigate to that collection's landing page. For a versioned collection, that landing page MUST be the index of its current documentation line.

#### Scenario: The bar lists every collection

- **WHEN** a documentation page is rendered on a viewport wide enough for the bar
- **THEN** the second-level bar lists Ecosystem, SDK, CLI, and Resources

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

### Requirement: A page states its position within its collection

Every documentation page SHALL carry a trail naming its position within its collection: the collection itself, every ancestor folder that has a page of its own, and the page. The trail MUST appear above the page's heading, and MUST be derived from the same navigation tree the sidebar is built from, so it cannot name a page the sidebar does not.

An ancestor folder that has no page of its own carries no entry, because an entry that leads nowhere is not a step a reader can take.

#### Scenario: A page deep in a collection names its whole path

- **WHEN** a page two folders below its collection is rendered
- **THEN** its trail names the collection, both folders, and the page, in that order

#### Scenario: A page directly below its collection names both ends

- **WHEN** a page one level below its collection is rendered
- **THEN** its trail names the collection and the page

#### Scenario: A folder with no page of its own is not named

- **WHEN** a page whose parent folder has no index page is rendered
- **THEN** that folder contributes no entry, and the trail names the collection and the page

### Requirement: The trail leads out within the reader's own documentation line

For a page of a versioned collection, the collection entry SHALL lead to the index of the documentation line the page belongs to, not to the line the collection currently serves. Climbing out of a page MUST NOT change which release the reader is reading.

#### Scenario: An older line's page climbs to that line

- **WHEN** a page of a past documentation line is rendered
- **THEN** its trail's collection entry leads to that line's index

#### Scenario: The current line's page climbs to the version-less index

- **WHEN** a page of the current documentation line is rendered
- **THEN** its trail's collection entry leads to the collection's version-less index

### Requirement: The trail offers no navigation to the page itself

The trail's last entry SHALL name the current page and MUST NOT be a link. Every entry before it MUST be a link to the page it names.

#### Scenario: The current page is named but not linked

- **WHEN** a page is rendered
- **THEN** the last entry of its trail carries the page's name and no link

#### Scenario: An ancestor is reachable

- **WHEN** a page's trail names an ancestor
- **THEN** that entry links the ancestor's page

### Requirement: A trail that would say nothing is not rendered

A collection's own index page SHALL carry no trail. The page is the collection, so a trail there would name it once as the path and once as the destination, and lead nowhere.

#### Scenario: A collection index carries no trail

- **WHEN** a collection's index page is rendered
- **THEN** no trail appears above its heading

#### Scenario: A documentation line's index carries no trail

- **WHEN** the index of a past documentation line is rendered
- **THEN** no trail appears above its heading

### Requirement: The trail's shape is asserted against the built pages

The trail SHALL be checked against the rendered HTML, because the rules that shape it belong to the documentation framework and a framework upgrade can change one without failing any other check. The assertion MUST cover the properties the requirements above state rather than the text of any particular trail.

#### Scenario: A framework change that drops the collection fails

- **WHEN** the built trail of a page below its collection omits the collection entry
- **THEN** the check fails and names the page

#### Scenario: A framework change that links the current page fails

- **WHEN** the last entry of a built trail carries a link
- **THEN** the check fails and names the page

