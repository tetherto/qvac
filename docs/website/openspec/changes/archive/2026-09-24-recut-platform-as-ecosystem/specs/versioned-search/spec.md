## MODIFIED Requirements

### Requirement: Every indexed page publishes retrieval attributes

Each page SHALL publish the attributes retrieval filters on: its collection, its documentation line, and whether that line is current. Because the current line's URLs carry no version segment, the line MUST be published as explicit page metadata and MUST NOT be left to inference from the URL.

#### Scenario: A versioned page publishes its line

- **WHEN** a rendered SDK page is inspected
- **THEN** it publishes attributes naming the collection, the documentation line, and whether the line is current

#### Scenario: The current line is not inferred from the URL

- **WHEN** a current-line page is indexed
- **THEN** its line comes from its published attributes, even though its URL has no version segment

#### Scenario: Unversioned pages publish no line

- **WHEN** an Ecosystem or Resources page is indexed
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

- **WHEN** a filtered query matches an Ecosystem or Resources page
- **THEN** the page is returned

#### Scenario: Another versioned collection is reachable at its current line

- **WHEN** a reader on an SDK `v0.18` page searches for something the CLI documents
- **THEN** the CLI's current line is returned, and no older CLI line is

#### Scenario: The model provider is found where it is documented

- **WHEN** a reader searches for the model provider or the OpenAI-compatible server
- **THEN** the CLI collection's HTTP-server pages are returned, carrying the CLI's collection attribute

#### Scenario: An assistant request path that cannot carry the filter is not shipped

- **WHEN** the assistant's request path cannot carry the attribute filter
- **THEN** the assistant is not wired to a version-scoped surface until a request path that can carry it is used
