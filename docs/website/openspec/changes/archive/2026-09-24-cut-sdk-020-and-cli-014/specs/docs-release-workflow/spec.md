## ADDED Requirements

### Requirement: A cut is performed by hand, and the build rejects a malformed one

Cutting a line SHALL be an ordinary content change — a rename, a copy, a manifest edit, and an edit to the redirects — performed by hand. No tool is required to make a cut correct; the build MUST be what rejects an incorrect one. A cut leaving a collection with anything but exactly one folder group, with a patch-shaped line name, with a line numbered above the folder group, or with folders and manifest entries that do not correspond MUST fail the build. The number of lines a cut leaves behind SHALL NOT be a reason to reject it.

#### Scenario: A cut needs no tooling

- **WHEN** an operator renames the folder group, copies it forward, updates the manifest, and adds the preserved line's index rules
- **THEN** the site builds and serves every line, with no script involved

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

## REMOVED Requirements

### Requirement: A cut is performed by hand and caught by the build

**Reason**: The gate counted lines, and the count was the one thing it checked that had no structural justification. It rejected a cut leaving three lines so that the fate of the oldest would be decided deliberately rather than by default; `docs-versioning` now decides it — every cut line stays published — so the count has nothing left to protect and blocks the routine cut instead.

**Migration**: Replaced by `A cut is performed by hand, and the build rejects a malformed one`, which keeps every other rejection the gate performs: exactly one folder group, no patch-shaped line name, no line numbered above the group, and folders that correspond to manifest entries. Only the line-count clause and the scenario asserting a third line fails are gone, the latter replaced by its inverse. In `src/lib/version-structure.ts` this is the removal of the `versions.length > 2` branch from `checkCollection`, and in `tests/line-structure.test.ts` the case asserting the rejection becomes one asserting a three-line collection is accepted.
