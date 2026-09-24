## MODIFIED Requirements

### Requirement: Each versioned collection tracks one package

Versioning SHALL be a property of a collection, not of the site. The SDK and CLI collections MUST be versioned; Ecosystem and Resources MUST NOT. A versioned collection MUST track exactly one package, and its line numbers MUST be that package's major and minor: the SDK tracks `@qvac/sdk`, and the CLI tracks `@qvac/cli`. A versioned collection MUST be named after the package it tracks, so that the thing being versioned and the thing being named are the same.

#### Scenario: Versioned collections carry a line, unversioned ones do not

- **WHEN** the published site is enumerated
- **THEN** every SDK and CLI page belongs to a documentation line
- **AND** no Ecosystem or Resources page belongs to a documentation line

#### Scenario: A line number matches its package release

- **WHEN** a documentation line of the SDK is published
- **THEN** its number is the major and minor of an `@qvac/sdk` release

#### Scenario: A collection is named after the package it tracks

- **WHEN** a versioned collection is enumerated
- **THEN** its name identifies the package its lines follow, not a feature of that package

#### Scenario: The CLI is one collection across its functions

- **WHEN** the CLI collection is enumerated
- **THEN** the model provider, SDK bundling, configuration, and the requirements check are documented inside the same collection and the same documentation line
- **AND** no function of the tool creates a collection or a line of its own

#### Scenario: The SDK is one collection across language interfaces

- **WHEN** the SDK collection is enumerated
- **THEN** the JavaScript, Python, Kotlin, and Swift interfaces are documented inside the same collection and the same documentation line
- **AND** no language interface creates a collection or a line of its own
