## MODIFIED Requirements

### Requirement: Sidebar trees remain declared, and a versioned line declares its own

The navigation of every collection SHALL be declared explicitly rather than inferred from the directory layout, and section grouping MUST remain expressible.

- The site source SHALL declare the order of collections and every unversioned collection's tree.
- Each versioned collection and each Ecosystem package SHALL declare its tree in `meta.json` files inside its package's `docs/users/` folder, so a line carries its own navigation from its pinned commit.
- Each line MUST be able to order, group, add, and omit entries independently.

#### Scenario: Every collection's navigation is declared, not generated

- **WHEN** the site source and the package documentation folders are inspected
- **THEN** every collection's entries and their order are explicitly declared in one place or the other

#### Scenario: A line's navigation comes from its commit

- **WHEN** a line is materialized
- **THEN** its sidebar is the one declared in that commit's documentation folder, with no declaration in the site source

#### Scenario: Lines may differ in structure

- **WHEN** one line orders, groups, or omits entries differently from another
- **THEN** each line's sidebar reflects its own declaration

### Requirement: The Ecosystem sidebar maps what QVAC publishes

The Ecosystem sidebar SHALL present what the project publishes, grouped under separators. Above the groups it MUST offer the collection overview and the project's vision.

- **Products** MUST reach the SDK, CLI, and Compose collections, the page inside the CLI that documents using it as a model provider, and the assistant app.
- **Platform** MUST reach Fabric and the Packages section.
- **Research** MUST reach the model family and the datasets.

An entry whose subject this site does not document MUST be a departure.

#### Scenario: Products reaches the products

- **WHEN** the Products group is read
- **THEN** it offers the SDK, CLI, and Compose collections, the model-provider page, and the assistant app

#### Scenario: Platform reaches the packages

- **WHEN** the Platform group is read
- **THEN** it offers Fabric and the Packages section

#### Scenario: An undocumented subject is linked, not written

- **WHEN** an entry names something this site holds no page for
- **THEN** it is a departure to where that subject is published
