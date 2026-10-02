## MODIFIED Requirements

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

- **WHEN** a reader on an SDK `v0.18` page searches for something the CLI documents
- **THEN** the CLI's current line is returned, and no older CLI line is

#### Scenario: The model provider is found where it is documented

- **WHEN** a reader searches for the model provider or the OpenAI-compatible server
- **THEN** the CLI collection's HTTP-server pages are returned, carrying the CLI's collection attribute

#### Scenario: An assistant request path that cannot carry the filter is not shipped

- **WHEN** the assistant's request path cannot carry the attribute filter
- **THEN** the assistant is not wired to a version-scoped surface until a request path that can carry it is used
