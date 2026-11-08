## MODIFIED Requirements

### Requirement: A line is published at the release cutoff

A release SHALL publish its documentation line by pinning it: the software's versions file gains a line for the released minor, declared first and pinned to the release commit. Pinning MUST NOT copy, move, or rename any documentation folder. A patch release within an existing minor SHALL move that line's pin and create no line.

#### Scenario: A minor release adds a pinned line

- **WHEN** `@qvac/sdk` `0.24.0` is released
- **THEN** the SDK versions file declares `v0.24` first, pinned to the release commit
- **AND** no documentation folder is copied or renamed

#### Scenario: A patch release moves the pin

- **WHEN** `@qvac/sdk` `0.24.1` is released
- **THEN** the `v0.24` line is pinned to the `0.24.1` release commit
- **AND** no new line is declared

### Requirement: An older line stays editable

A released line SHALL be corrected on the release branch of the highest patch in its minor, and the correction SHALL be published by moving that line's pin to the corrected commit.

#### Scenario: A released line is corrected

- **WHEN** a documentation fix is merged into `release-sdk-0.23.2`
- **THEN** the `v0.23` line's pin moves to the merged commit through a pull request on `main`

### Requirement: A cut adds redirects only for pages the new line drops

When a new line becomes current, redirects SHALL be added only for pages the new line drops. A page carried by both lines keeps resolving at its version-less path without a rule.

#### Scenario: A dropped page is redirected

- **WHEN** the new current line no longer carries a page the previous line carried
- **THEN** the page's version-less path redirects to the new line's nearest equivalent

#### Scenario: A carried page needs no rule

- **WHEN** a page exists in both lines
- **THEN** no redirect rule is added for it

### Requirement: A version is only written into the line that carries it

Documentation for a version not yet released SHALL be written in the package's documentation folder on `main`. Documentation for a released version SHALL be written on that version's release branch. A generator that writes a page describing a release MUST refuse to write it anywhere else, and MUST name the version and the place it belongs.

#### Scenario: The coming version is written on main

- **WHEN** a feature pull request documents behaviour of the unreleased version
- **THEN** it edits the package's documentation folder on `main`

#### Scenario: A generator refuses the wrong destination

- **WHEN** a generator is run for a released version against `main`
- **THEN** it refuses, names the version and its release branch, and writes nothing

## ADDED Requirements

### Requirement: A documentation-only change to a release branch publishes no package

A change whose every path lies under `packages/*/docs/users/` SHALL be classified as documentation-only by one shared classifier. On a release branch, such a change:

- MUST be exempt from the version-bump and changelog guards;
- MUST NOT trigger a package publication;
- SHALL open a pull request on `main` that moves the affected line's pin.

#### Scenario: A docs-only fix passes the release guard

- **WHEN** a pull request into a release branch touches only `packages/sdk/docs/users/`
- **THEN** the release guard does not require a version bump or a changelog section

#### Scenario: A docs-only push publishes nothing

- **WHEN** a documentation-only change is pushed to a release branch
- **THEN** no package publication starts
- **AND** a pull request moving the line's pin is opened on `main`

#### Scenario: A mixed change is not documentation-only

- **WHEN** a change touches both documentation and source files
- **THEN** the classifier rejects it, and the normal release rules apply

### Requirement: A line is published by a pin update, and the build rejects a malformed one

A pin update SHALL be an ordinary reviewable diff to a versions file, whether a workflow or a person writes it. The build SHALL reject a malformed versions file, naming the software:

- a line number above the current line declared below it;
- a patch-shaped line number;
- a duplicate line;
- a commit that cannot be fetched.

#### Scenario: A malformed versions file fails the build

- **WHEN** a versions file declares `v0.23.1` as a line
- **THEN** the build fails and names the software and the line

## REMOVED Requirements

### Requirement: A cutoff reads the work in flight, and the checks flag what it strands

**Reason**: No folder is copied or renamed any more, so a pull request in flight cannot be stranded by a publication.
**Migration**: Feature pull requests write to the package's documentation folder, whose path never changes.

### Requirement: A cut is performed by hand, and the build rejects a malformed one

**Reason**: The manual cut is removed. Publication is a pin update.
**Migration**: Use "A line is published by a pin update, and the build rejects a malformed one".

### Requirement: The cutoff regenerates the API summary of the version being released

**Reason**: The Nunjucks API summary is retired. Generated API data is committed in the package and kept fresh on every pull request.
**Migration**: See the `api-reference` capability.

### Requirement: The currency marker follows the cut

**Reason**: Currency is read from the versions files and labelled at build time. No page title states it by hand.
**Migration**: The release label on the breadcrumb row (`version-navigation`) states whether a line is current.
