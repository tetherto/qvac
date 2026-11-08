## ADDED Requirements

### Requirement: Packages documents the internal packages inside Ecosystem

The Ecosystem collection SHALL hold a Packages section with one entry per listed internal package. A package SHALL be listed only when it has a versions file. Test, CI, smoke, and private packages MUST NOT be listed. Software that has its own versioned collection MUST NOT appear in Packages.

#### Scenario: Only declared packages are listed

- **WHEN** the Packages section is rendered
- **THEN** it lists exactly the packages that have a versions file of kind `internal-machinery`

#### Scenario: Entry points are not packages

- **WHEN** the Packages section is enumerated
- **THEN** it contains no entry for software that has its own versioned collection

### Requirement: Each package is versioned on its own

Each listed package SHALL publish its declared lines, pinned to commits like a collection's. Its newest line SHALL be served at `/ecosystem/packages/<name>/` and every other line at `/ecosystem/packages/<name>/v<major>.<minor>/`. A package's lines MUST be moved between with the same switcher the collections use.

#### Scenario: A package's newest line has the version-less path

- **WHEN** `translation-nmtcpp` publishes `v1.4` and `v1.3`
- **THEN** `v1.4` resolves at `/ecosystem/packages/translation-nmtcpp/` and `v1.3` at `/ecosystem/packages/translation-nmtcpp/v1.3/`

#### Scenario: The switcher moves between a package's lines

- **WHEN** a reader on a package page selects another line
- **THEN** the equivalent page of that line opens, or its index when the page is absent

### Requirement: A package page points to the canonical user-facing software

Every package's overview SHALL state which user-facing software is the canonical way to use its capability, and link to it.

#### Scenario: A package overview names its user-facing software

- **WHEN** a package overview is rendered
- **THEN** it names and links the user-facing software that exposes the package's capability
