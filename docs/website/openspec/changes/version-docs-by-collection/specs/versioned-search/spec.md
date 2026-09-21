## ADDED Requirements

### Requirement: Every indexed page publishes retrieval attributes

Each page SHALL publish the attributes retrieval filters on: its collection, its documentation line, and whether that line is current. Because the current line's URLs carry no version segment, the line MUST be published as explicit page metadata and MUST NOT be left to inference from the URL.

#### Scenario: A versioned page publishes its line

- **WHEN** a rendered SDK page is inspected
- **THEN** it publishes attributes naming the collection, the documentation line, and whether the line is current

#### Scenario: The current line is not inferred from the URL

- **WHEN** a current-line page is indexed
- **THEN** its line comes from its published attributes, even though its URL has no version segment

#### Scenario: Unversioned pages publish no line

- **WHEN** a Platform or Resources page is indexed
- **THEN** it publishes its collection and no documentation line

### Requirement: Search and the assistant are scoped to the reader's line

While a reader is inside a documentation line, Search and the AI Assistant SHALL restrict retrieval to that line, the unversioned collections, and the current line of every other versioned collection. No other line of the reader's own collection may be retrieved. Both surfaces MUST send the restriction as an attribute filter on the request, so it is enforced by retrieval and not by ranking.

#### Scenario: Search is filtered to the active line

- **WHEN** the reader searches from an SDK `v0.18` page
- **THEN** the request carries an attribute filter for the SDK `v0.18` line
- **AND** results from other SDK lines are not returned

#### Scenario: The assistant answers inside the line

- **WHEN** the reader asks the assistant a question from an SDK `v0.18` page
- **THEN** the request carries the same restriction, and the answer cites no other SDK line

#### Scenario: Unversioned content stays reachable

- **WHEN** a filtered query matches a Platform or Resources page
- **THEN** the page is returned

#### Scenario: Another versioned collection is reachable at its current line

- **WHEN** a reader on an SDK `v0.18` page searches for something the Provider documents
- **THEN** the Provider's current line is returned, and no older Provider line is

#### Scenario: An assistant request path that cannot carry the filter is not shipped

- **WHEN** the assistant's request path cannot carry the attribute filter
- **THEN** the assistant is not wired to a version-scoped surface until a request path that can carry it is used

### Requirement: Unscoped queries favour the current line

A query issued outside any line — from an unversioned page or a site-wide entry point — SHALL favour the current line. Older lines MUST NOT be returned above it, and any result from an older line MUST be labelled with its line.

#### Scenario: Site-wide search prefers the current line

- **WHEN** a query is issued from an unversioned page
- **THEN** current-line and unversioned pages rank above older-line pages

#### Scenario: Older results are labelled

- **WHEN** a result from an older line is returned
- **THEN** it is labelled with its documentation line

### Requirement: Programmatic queries state the collection and line

A query issued through the site's programmatic retrieval surface SHALL be able to state a collection and a line, and the response SHALL state the line each result came from. Omitting the line MUST behave as an unscoped query.

#### Scenario: A programmatic query is scoped

- **WHEN** a query names the SDK collection and the `v0.19` line
- **THEN** only pages of that line and of unversioned collections are returned

#### Scenario: Results name their line

- **WHEN** results are returned
- **THEN** each states the collection and line it came from
