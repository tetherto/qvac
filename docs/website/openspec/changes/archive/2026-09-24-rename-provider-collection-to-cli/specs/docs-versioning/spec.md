## MODIFIED Requirements

### Requirement: Each versioned collection tracks one package

Versioning SHALL be a property of a collection, not of the site. The SDK and CLI collections MUST be versioned; Platform and Resources MUST NOT. A versioned collection MUST track exactly one package, and its line numbers MUST be that package's major and minor: the SDK tracks `@qvac/sdk`, and the CLI tracks `@qvac/cli`. A versioned collection MUST be named after the package it tracks, so that the thing being versioned and the thing being named are the same.

#### Scenario: Versioned collections carry a line, unversioned ones do not

- **WHEN** the published site is enumerated
- **THEN** every SDK and CLI page belongs to a documentation line
- **AND** no Platform or Resources page belongs to a documentation line

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

## ADDED Requirements

### Requirement: At most two documentation lines per versioned collection

A versioned collection SHALL publish the current line and, once a release has cut one, the previous line — at most two. Two is the minimum that exercises switching, fallback, canonical resolution, and corpus isolation, and the previous line starts as what the site served before the cut rather than as content written ahead of a release.

#### Scenario: The SDK publishes both of its lines

- **WHEN** the content tree is enumerated after this change ships with `@qvac/sdk` `0.19`
- **THEN** the SDK publishes `(v0.19)` and `v0.18`
- **AND** `v0.18` starts as what the site served before the cut

#### Scenario: The CLI publishes both of its lines

- **WHEN** the content tree is enumerated after the CLI is cut
- **THEN** the CLI publishes `(v0.13)`, the release that is live, and `v0.12`, the one before it
- **AND** both collections therefore exercise switching, fallback, and corpus isolation

#### Scenario: A collection can publish one line

- **WHEN** a versioned collection has published only one release
- **THEN** it publishes one line, and everything except switching still works

#### Scenario: A third line is not published

- **WHEN** a cut would leave three lines
- **THEN** it does not proceed, because what becomes of the oldest line is not defined by this change

#### Scenario: Adding a line requires no routing change

- **WHEN** a line folder is added and declared
- **THEN** it is published and offered by the switcher without any change to route definitions

## REMOVED Requirements

### Requirement: Up to two documentation lines per versioned collection

**Reason**: The rule is unchanged, but one of its scenarios named the Provider, and that collection no longer exists. A scenario cannot be renamed inside a MODIFIED block — OpenSpec refuses to drop a scenario the baseline carries — so the requirement is revoked and restated under a name of its own.

**Migration**: Replaced by "At most two documentation lines per versioned collection", identical in substance: the current line plus, once a release has cut one, the previous line. Only the scenario naming the collection changed, from the Provider to the CLI.
