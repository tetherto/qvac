## ADDED Requirements

### Requirement: The inventory may be built without being published

The Software Inventory MAY be carried in the repository without being served. While it is unpublished its pages SHALL be kept under `content/_unpublished/`, and the manifest SHALL list no package. No navigation entry, redirect rule, or check MAY name a page the export does not emit. The other requirements of this capability continue to describe the inventory as it will be served, and are not suspended by its absence.

The state is reversible by construction: everything the inventory builds is derived from the manifest's package entries, so publishing it SHALL cost the move of one folder, the entries themselves, and the redirect rules a package needs — and no other edit. Where a surface cannot derive that, it MUST record what restores it.

Unpublishing is available only while no version page has ever been served. A published version page keeps resolving for as long as its entry exists, so an inventory that has been published is grown rather than withdrawn.

#### Scenario: An unpublished inventory serves nothing

- **WHEN** the site is built with no package listed in the manifest
- **THEN** no inventory page is emitted, and the Ecosystem navigation names no inventory

#### Scenario: The pages are kept, not deleted

- **WHEN** the inventory is unpublished
- **THEN** its pages are under `content/_unpublished/`, as written

#### Scenario: Nothing dangles

- **WHEN** the inventory is unpublished
- **THEN** no navigation entry, redirect rule, or check names an inventory page
- **AND** the build passes with every other check unchanged

#### Scenario: Publishing is the manifest and the folder

- **WHEN** the inventory is published
- **THEN** its folder returns under `content/docs/` and its packages are listed in the manifest
- **AND** no surface derived from the manifest needs an edit of its own

#### Scenario: A published inventory is not withdrawn

- **WHEN** a version page has been served
- **THEN** its entry may grow but may not be unpublished, because the page must keep resolving
