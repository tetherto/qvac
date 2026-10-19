## MODIFIED Requirements

### Requirement: Agent artifacts are gated against cross-line leakage

Cross-line leakage SHALL fail the build. A line-scoped artifact MUST NOT reference a URL belonging to another line of a versioned collection; it MAY reference unversioned pages of any collection, and MAY reference another versioned collection at that collection's current line. Every URL it lists MUST resolve.

#### Scenario: A URL from another line fails the build

- **WHEN** a line's artifact lists a URL belonging to another line of a versioned collection
- **THEN** the build fails and names the artifact and the URL

#### Scenario: Unversioned URLs are allowed

- **WHEN** a line's artifact lists a Platform or Resources URL
- **THEN** the check passes

#### Scenario: Another versioned collection is referenced at its current line

- **WHEN** an SDK line's artifact references the CLI
- **THEN** it uses the CLI's version-less path, and the check passes

#### Scenario: Artifacts have no dead links

- **WHEN** the artifacts are read to detect leakage
- **THEN** the same pass resolves every URL they list against the built page set, because the HTML broken-link step never opens them
