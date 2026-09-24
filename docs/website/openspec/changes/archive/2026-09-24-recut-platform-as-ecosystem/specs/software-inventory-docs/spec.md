## MODIFIED Requirements

### Requirement: Each package is entered at an index that lists its versions

Each inventory entry SHALL be reachable at a version-less path serving an index page for the package itself, not a version of it. That page MUST carry the package's published name, one sentence stating what the package is, a link to its repository and to its registry listing, and the list of versions the site documents, each linking that version's page and its GitHub release. Every version page, including the newest, MUST be addressed at a versioned path, so no inventory URL changes what it serves when a release happens. The Software Inventory index MUST list every documented package by its published name and link it to that package's index.

#### Scenario: The package path serves the index

- **WHEN** `/ecosystem/inventory/cli/` is requested
- **THEN** the package index is served, listing the documented versions
- **AND** no README is served at that path

#### Scenario: The newest version is addressed like any other

- **WHEN** the newest documented version of a package is requested
- **THEN** its path carries the version segment, exactly as an older one does

#### Scenario: Documenting a release changes no existing URL

- **WHEN** a new version is documented
- **THEN** every existing version URL still serves what it served
- **AND** the package index gains one entry

#### Scenario: The inventory index lists the packages

- **WHEN** the Software Inventory index is rendered
- **THEN** it lists each documented package by its published name and links to that package's index

#### Scenario: An index that disagrees with the manifest fails the build

- **WHEN** a package index links a version the manifest does not declare, or omits one it does
- **THEN** the build fails and names the package and the version

## ADDED Requirements

### Requirement: The Software Inventory documents packages and is entered from Ecosystem

The Ecosystem collection SHALL contain a Software Inventory that documents the published packages themselves. A collection documents a product — what it is for and how to build with it — while an inventory entry documents one distributable: what the package is, how to install it, how to use it, and what its API surface is. The same product MAY be delivered by several packages, and each MUST get its own entry.

#### Scenario: The inventory is entered from Ecosystem

- **WHEN** the Ecosystem collection is browsed
- **THEN** the Software Inventory is reachable from it, and it lists the documented packages

#### Scenario: One entry per package

- **WHEN** a product is delivered by several packages
- **THEN** the inventory contains one entry per package, each named by its published package name

#### Scenario: Inventory and collection do not duplicate each other

- **WHEN** an inventory entry and a product collection both cover a topic
- **THEN** the inventory entry documents the package surface and links to the collection for product guidance, instead of restating it

## REMOVED Requirements

### Requirement: The Software Inventory documents packages, not products

**Reason**: The rule is unchanged, but the collection the inventory is entered from is renamed, and that collection is named in the requirement's body and in one of its scenario names. A scenario cannot be renamed inside a MODIFIED block, because OpenSpec refuses to drop a scenario the baseline carries.

**Migration**: Replaced by "The Software Inventory documents packages and is entered from Ecosystem", identical in substance: an inventory entry documents one distributable rather than a product, and a product delivered by several packages gets one entry per package.
