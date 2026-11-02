## ADDED Requirements

### Requirement: A version is only written into the line that carries it

A generator that writes a page describing a release SHALL refuse when the version it was given does not belong to the line it would write into. It MUST refuse before writing anything, and MUST name both the version asked for and the line that is current.

The check exists because the destination is resolved from the manifest rather than named on the command line, so a release run before its line was cut would otherwise land in the previous line, overwrite that line's own record of itself, and leave a tree that builds and tests clean. A released line is never regenerated, and this is what enforces it.

#### Scenario: A version matching the current line is generated

- **WHEN** a generator is run for a version whose major and minor are the current line's
- **THEN** it writes into that line

#### Scenario: A version ahead of the current line is refused

- **WHEN** a generator is run for the coming release and the line for it has not been cut
- **THEN** it refuses, names the version and the current line, and writes nothing

#### Scenario: An older line is not regenerated

- **WHEN** a generator is run for a version whose line has already been preserved
- **THEN** it refuses, because that line is what the site already serves

### Requirement: A release regenerates the reference pages of the current line

Releasing SHALL regenerate only the API summary and the release notes of the current line, by running the two generators directly. No other surface is a release's to write: the manifest and the redirects belong to the cut, and every remaining surface is derived at build time.

A minor release SHALL render both pages. A patch release SHALL append its section to the release notes and leave the API summary untouched, because the public API is frozen at the minor boundary. Releasing SHALL be preceded by the cut that opened the line being released, and the instructions an operator follows MUST say so.

#### Scenario: A minor renders both pages

- **WHEN** a minor release is documented
- **THEN** the API summary and the release notes of the current line are rendered

#### Scenario: A patch leaves the API summary alone

- **WHEN** a patch release is documented
- **THEN** its section is appended to the release notes and the API summary is not rewritten

#### Scenario: A release does not touch the cut's inputs

- **WHEN** a release is documented
- **THEN** neither the version manifest nor the redirects are modified

### Requirement: The currency marker follows the cut

Where a page states in its own text that it belongs to the current line, that statement SHALL be maintained by the cut, which is the only event that changes which line is current. A cut MUST clear the marker from the line it preserves and carry it, with the new line's number, onto the line it opens.

A generator rendering a page of the current line MUST preserve the marker the cut set, so regenerating never silently demotes the line it writes into.

#### Scenario: The preserved line stops claiming to be current

- **WHEN** a line is preserved by a cut
- **THEN** its pages no longer carry the marker

#### Scenario: The opened line carries the marker with its own number

- **WHEN** a line is opened by a cut
- **THEN** its pages carry the marker and name the new line

#### Scenario: Regenerating does not drop the marker

- **WHEN** a page of the current line is regenerated
- **THEN** it still carries the marker

## MODIFIED Requirements

### Requirement: A cut is performed by hand, and the build rejects a malformed one

Cutting a line SHALL be an ordinary content change — a rename, a copy, a manifest edit, and an edit to the redirects — that can be performed by hand. No tool is required to make a cut correct; the build MUST be what rejects an incorrect one. A cut leaving a collection with anything but exactly one folder group, with a patch-shaped line name, with a line numbered above the folder group, or with folders and manifest entries that do not correspond MUST fail the build. The number of lines a cut leaves behind SHALL NOT be a reason to reject it.

A command MAY be provided that performs the whole cut for one collection, and it SHALL produce exactly the edit a person would make by hand. It MUST NOT become a step anything depends on: the hand procedure stays documented, and releasing MUST NOT require it. It SHALL refuse a cut it cannot make reviewable — an unversioned collection, a version not above the current line, a destination already occupied, or a working tree that already carries changes — and it SHALL leave verification to the build rather than reporting success of its own.

#### Scenario: A cut needs no tooling

- **WHEN** an operator renames the folder group, copies it forward, updates the manifest, and adds the preserved line's index rules
- **THEN** the site builds and serves every line, with no script involved

#### Scenario: A cut made by the command is the same cut

- **WHEN** the command cuts a collection's next line
- **THEN** the result is what the hand procedure produces, and the build accepts it

#### Scenario: An unreviewable cut is refused

- **WHEN** the command is asked to cut into an occupied destination, below the current line, on an unversioned collection, or over uncommitted work
- **THEN** it refuses and changes nothing

#### Scenario: An invalid structure fails the build

- **WHEN** a collection ends up with zero or two folder groups, a patch-shaped line name, or a line numbered above the folder group
- **THEN** the build fails and names the collection and the offending folder

#### Scenario: A third line builds

- **WHEN** a collection ends up with three lines, or with more
- **THEN** the build succeeds, and every line is published, switchable, and given its own corpus

#### Scenario: A cut adds the preserved line's index rules

- **WHEN** a cut preserves the outgoing line under its plain versioned folder
- **THEN** `public/_redirects` gains that line's index pair — the `200` rewrite and the `301` below it — because the line's last segment carries a dot and so misses the CDN's slash normalization

#### Scenario: A cut that drops no page adds no page rule

- **WHEN** the new line is an exact copy of the one it was cut from
- **THEN** no redirect is added for any page, because none stopped resolving
