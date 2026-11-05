## MODIFIED Requirements

### Requirement: The Markdown of a page states its documentation line

The Markdown the site already publishes for every page SHALL additionally state the collection, the documentation line, the tracked package, whether the line is current, and the canonical URL. The metadata MUST be derived at build time from the page's location, never hand-written in frontmatter.

#### Scenario: Markdown states its line

- **WHEN** the Markdown of an SDK page is fetched
- **THEN** it states the collection, the line, the tracked package, whether the line is current, and the canonical URL

#### Scenario: Metadata cannot drift from location

- **WHEN** a page is moved into a different line
- **THEN** its Markdown metadata changes with it, with no edit to the page

#### Scenario: Unversioned pages say so

- **WHEN** the Markdown of an Ecosystem page is fetched
- **THEN** it declares no documentation line

### Requirement: Agent artifacts are gated against cross-line leakage

Cross-line leakage SHALL fail the build. A line-scoped artifact MUST NOT reference a URL belonging to another line of a versioned collection; it MAY reference unversioned pages of any collection, and MAY reference another versioned collection at that collection's current line. Every URL it lists MUST resolve.

#### Scenario: A URL from another line fails the build

- **WHEN** a line's artifact lists a URL belonging to another line of a versioned collection
- **THEN** the build fails and names the artifact and the URL

#### Scenario: Unversioned URLs are allowed

- **WHEN** a line's artifact lists an Ecosystem or Resources URL
- **THEN** the check passes

#### Scenario: Another versioned collection is referenced at its current line

- **WHEN** an SDK line's artifact references the CLI
- **THEN** it uses the CLI's version-less path, and the check passes

#### Scenario: Artifacts have no dead links

- **WHEN** the artifacts are read to detect leakage
- **THEN** the same pass resolves every URL they list against the built page set, because the HTML broken-link step never opens them
