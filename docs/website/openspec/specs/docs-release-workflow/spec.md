## Purpose

What a release does to the documentation. When a line is cut and what the cut consists of, which surfaces regenerate themselves from the line set, which redirects a cut owes and which it does not, and what the build rejects in a malformed cut.
## Requirements
### Requirement: A line is cut as soon as the previous release is live

Publishing a documentation line SHALL happen immediately after a release deploys, not when the next one does, and consist of three moves in one change: renaming the outgoing folder group to its plain versioned form, which preserves what the site is serving, copying it to the coming release's folder group, which becomes current, and updating the version manifest so its entries name the folders as they now stand. A cut SHALL be made for every tracked package with a version scheduled in the coming cycle, and MAY also be made ahead of any schedule to demonstrate the model. Documentation describing that version MUST land in the folder group, and MUST NOT be written into an older line.

#### Scenario: A cut preserves the outgoing line and opens the new one

- **WHEN** `@qvac/sdk` `0.16` has been deployed and `0.17` is the version being prepared
- **THEN** `(v0.18)` becomes `v0.18` and a copy of it becomes `(v0.19)`
- **AND** the manifest renames the `v0.18` entry's folder and gains a `v0.19` entry naming the group
- **AND** the collection's version-less paths serve `v0.19` from the deploy that releases it

#### Scenario: A half-done cut does not build

- **WHEN** the folders are cut and the manifest is not updated, or the manifest is updated and the folders are not cut
- **THEN** the build fails and names the line that disagrees

#### Scenario: The preserved line starts as what was served

- **WHEN** a line is preserved by a cut
- **THEN** its pages are what the collection's version-less paths served immediately before the cut

#### Scenario: The new line starts complete

- **WHEN** the copy is built before any release-specific edit
- **THEN** it contains every page of the older line, at the same paths, and resolves at the version-less paths

#### Scenario: New-release material does not land in an older line

- **WHEN** a page is written or edited to describe the new release
- **THEN** the edit lands in the folder group

### Requirement: An older line stays editable

An older line SHALL remain an ordinary content folder. Correcting one of its pages, or adding a page that documents its release, MUST be possible at any time and MUST require nothing beyond editing that folder. A cut fixes where a line's content came from, not whether it may change afterwards.

#### Scenario: An older line's page can be corrected

- **WHEN** a page of an older line is edited
- **THEN** the change publishes on the next build, with no cut and no promotion involved

#### Scenario: An older line can gain a page

- **WHEN** a page is added to an older line
- **THEN** it resolves under that line's version segment and appears in that line's sidebar and artifacts

#### Scenario: Editing an older line does not touch the current one

- **WHEN** an older line is edited
- **THEN** the current line is unchanged

### Requirement: A cut adds redirects only for pages the new line drops

Because the version-less paths keep resolving after a cut, a page carried by both lines SHALL need no redirect. A page the new line does not carry SHALL keep resolving by redirecting its version-less path to the current line's index, which is one rule per dropped page and nothing more. Sending the reader to a single known destination is the whole rule: mapping a dropped page onto its older-line counterpart is an improvement to make when a cut actually drops pages.

#### Scenario: A carried page needs no redirect

- **WHEN** a page exists in both the older and the current line
- **THEN** its version-less path resolves directly, without a redirect

#### Scenario: A dropped page redirects to the current line's index

- **WHEN** the new line does not carry a page the previous one served
- **THEN** its version-less path redirects to the current line's index

#### Scenario: A cut adds rules, not code

- **WHEN** the URL set published before a cut is replayed after it
- **THEN** every URL still published resolves, and every dropped one resolves through the rule added for it
- **AND** nothing beyond `public/_redirects` was edited to achieve it

### Requirement: Publishing regenerates every derived surface

Every surface derived from the line set — the switcher, the sidebars, the canonical URLs, the agent artifacts, `versions.json`, the sitemap, and the retrieval metadata each page publishes — SHALL be computed at build time from the manifest and the folders it is checked against, so a cut updates them by being built. None may be maintained by hand. The manifest and the redirects are the two hand-edited inputs: the manifest because a line is published by declaring it, the redirects because the CDN takes configuration rather than build output. The build checks both.

#### Scenario: Derived surfaces follow the line set

- **WHEN** the line set changes and the site is rebuilt
- **THEN** every derived surface reflects the new set

#### Scenario: A stale derived surface fails the build

- **WHEN** a derived surface disagrees with the declared line set
- **THEN** the build fails and names the surface

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

