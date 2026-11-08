## MODIFIED Requirements

### Requirement: Content is partitioned into collections

The documentation content SHALL be partitioned into collections, and every collection MUST own the URL namespace formed by its name.

- An unversioned collection's content MUST live in its folder under `docs/website/content/docs/`.
- A versioned collection's content MUST live in its package's `docs/users/` folder and be materialized per line.

Every published page MUST belong to exactly one collection.

#### Scenario: Every published page belongs to a collection

- **WHEN** the built page set is enumerated
- **THEN** every page resolves under exactly one collection

#### Scenario: A collection owns its URL namespace

- **WHEN** a page belonging to collection `<collection>` is requested
- **THEN** its URL starts with `/<collection>/`

#### Scenario: Versioned content lives with its package

- **WHEN** the SDK collection's source is located
- **THEN** it is `packages/sdk/docs/users/`, and nothing under `docs/website/content/docs/sdk/` is published

### Requirement: Collections introduced by this change

The site SHALL provide exactly these collections:

- `ecosystem`;
- `sdk`;
- `cli`;
- `compose`, once its package publishes a release;
- `resources`.

Research and the assistant app MUST be reached as departures rather than as collections. A collection MUST be named after what it holds.

#### Scenario: Only the agreed collections exist

- **WHEN** the collections are listed
- **THEN** they are exactly `ecosystem`, `sdk`, `cli`, `resources`, and `compose` when Compose has a published line

#### Scenario: Research and the assistant app are departures

- **WHEN** the navigation is read
- **THEN** Research leads to the project's model and dataset hub, the assistant app leads to its own site, and neither is a collection

### Requirement: Ecosystem collection composition

The `ecosystem` collection SHALL hold what describes QVAC as a whole and the Packages section that documents the internal packages, entered from an overview. It MUST NOT hold a product collection's guidance. Where a subject is published elsewhere, the collection MUST reach it by a departure.

#### Scenario: Ecosystem holds the overview and Packages

- **WHEN** the `ecosystem` collection is enumerated
- **THEN** it contains an overview and the Packages section

#### Scenario: Product guidance stays in its collection

- **WHEN** an Ecosystem page touches a topic a product collection documents
- **THEN** it links to that collection instead of restating it
