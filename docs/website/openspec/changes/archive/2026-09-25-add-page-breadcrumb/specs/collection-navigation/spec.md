## ADDED Requirements

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
