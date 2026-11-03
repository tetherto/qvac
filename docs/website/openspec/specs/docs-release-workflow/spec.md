## Purpose

What a release does to the documentation. When a line is cut and what the cut consists of, which surfaces regenerate themselves from the line set, which redirects a cut owes and which it does not, and what the build rejects in a malformed cut.
## Requirements
### Requirement: A line is published at the release cutoff

A versioned collection SHALL write its coming release into a **development line** that the site does not publish, and SHALL publish that line at the release cutoff — when the version's release branch is cut, not when the release deploys. Publishing SHALL consist of three moves in one change: renaming the outgoing folder group to its plain versioned form, which preserves what the site is serving; **copying** the development line into the collection as the new folder group; and updating the version manifest so its entries name the folders as they now stand. The development line SHALL remain in place after the cut, and is then the next version's. A cut SHALL be made for each collection whose package the release moves, and collections SHALL be cuttable independently of one another. Documentation describing an unreleased version MUST land in the development line, and MUST NOT be written into a published one.

The development line SHALL be addressed by a name that does not change from one version to the next, so that the path a change writes to is the same before and after a cutoff. The development line SHALL NOT be renamed or deleted by a cut: a change written into it before a cutoff and merged after it MUST land in the path it was written to, with no rename for the version-control system to replay it through.

That guarantee covers the development line and no other. A cut renames the outgoing folder group, and the group it opens is byte-identical to the outgoing one wherever the version being released changed nothing, so a change written into the group before a cutoff and merged after it has two exact rename candidates per page and MAY be replayed into either line. The cutoff and the pull-request checks are what close that window, not the folder layout.

#### Scenario: A cut preserves the outgoing line and publishes the one being released

- **WHEN** `@qvac/sdk` `0.19` is the line last cut and `0.20` is the version being released
- **THEN** `(v0.19)` becomes `v0.19` and a copy of the development line becomes `(v0.20)`
- **AND** the manifest renames the `v0.19` entry's folder and gains a `v0.20` entry naming the group
- **AND** the development line is still on disk, unchanged, and is now `0.21`'s

#### Scenario: A change in flight across a cutoff lands in its own version

- **WHEN** a change is written into the development line before a cutoff and merged after it
- **THEN** it lands in the development line, which the cutoff left in place
- **AND** no published line is modified by the merge

#### Scenario: A change written into the outgoing group across a cutoff is not placed by the merge

- **WHEN** a page the version being released did not change is edited in the folder group before a cutoff, and the pull request merges after it
- **THEN** the preserved line and the opened group both hold an identical copy of that page, so the merge resolves the edit into whichever the version-control system pairs the rename with
- **AND** nothing in the folder layout decides which, so the pull request MUST be rebased before it merges

#### Scenario: A half-done cut does not build

- **WHEN** the folders are cut and the manifest is not updated, or the manifest is updated and the folders are not cut
- **THEN** the build fails and names the line that disagrees

#### Scenario: The preserved line starts as what was served

- **WHEN** a line is preserved by a cut
- **THEN** its pages are what the collection's version-less paths served immediately before the cut

#### Scenario: One collection is cut without the others

- **WHEN** a release moves one versioned collection's package and not another's
- **THEN** only that collection is cut, and every other collection's folders and manifest entries are unchanged

#### Scenario: The development line is not published

- **WHEN** the site is built
- **THEN** no page of the development line is rendered and no URL resolves to one

#### Scenario: New-release material does not land in a published line

- **WHEN** a page is written or edited to describe the coming release
- **THEN** the edit lands in the development line

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

### Requirement: A cutoff reads the work in flight, and the checks flag what it strands

Because a cut changes which release a documentation path belongs to, and renames the outgoing folder group, a pull request open across a cutoff SHALL be reported rather than left to merge on the version-control system's judgement.

Before cutting, the cutoff SHALL list the open pull requests writing either line of each collection being cut, and SHALL report the choice each one forces: a pull request writing the development line with documentation for the release being cut has to merge before the cut, or the release ships without it; one writing the outgoing group has to be rebased after the cutoff merges. Cutting with pull requests outstanding SHALL be permitted — the requirement is that the list is read, not that it is empty.

After a cutoff, a pull request whose branch point precedes it and whose diff touches a collection's published lines SHALL fail a pull-request check, and the check SHALL clear only when the branch is rebased. The check SHALL compare the collection's folder group at the parent of the pull request's oldest commit against the folder group on the base branch, and MUST NOT use the merge base, which a merge from the base branch moves past the cutoff while carrying the misplacement in with it. A pull request that touches no published line SHALL be unaffected, as SHALL a collection the cutoff did not move. Whether that failure also withholds the merge is a branch-protection decision outside this specification; what is required is that the failure is raised and names the window.

The check SHALL NOT read the development line. A change written there crosses a cutoff intact, so failing it would buy nothing while costing every open pull request that carries documentation a rebase at every cutoff, dismissing the approvals it already has. The question the development line does raise — documentation reaching readers a version late because it merged after the cut — is answered by the inventory above, before the cut.

Failing the check buys a human decision, not a correct one: nothing validates where the author puts the change during the rebase, and a failure that does not withhold the merge can be merged past. Removing the rename altogether — a folder group whose name does not carry its version, so that a cut copies the group to its archived version and overwrites it from the development line — is what would make the placement unambiguous, and is not required here.

#### Scenario: The cutoff reports a pull request it will strand

- **WHEN** a collection is cut while a pull request writing its outgoing group is open
- **THEN** the cutoff names that pull request and states that it has to be rebased once the cutoff merges
- **AND** the cut proceeds

#### Scenario: A pull request opened before the cutoff fails the check after it

- **WHEN** a pull request whose branch point precedes the cutoff edits a collection's published line
- **THEN** the pull-request check fails and names the folder group as it stood at the branch point and as it stands on the base branch
- **AND** rebasing the branch is what makes the check pass

#### Scenario: Merging the base branch does not satisfy the check

- **WHEN** the base branch is merged into such a pull request instead of the branch being rebased
- **THEN** the check still fails, because it reads the branch point and not the merge base

#### Scenario: A pull request that writes only the development line is unaffected

- **WHEN** a pull request opened before a cutoff writes documentation into a collection's development line and into no published line
- **THEN** the check passes, because the path it writes to means the same thing on both sides of the cut
- **AND** no rebase is asked of it, so the approvals it already carries stand

#### Scenario: A pull request that writes no documentation line is unaffected

- **WHEN** a pull request opened before a cutoff touches the site's source, tests or configuration but no line of any collection
- **THEN** the check passes

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

Cutting a line SHALL be an ordinary content change — a rename, a copy, a manifest edit, and an edit to the redirects — that can be performed by hand. No tool is required to make a cut correct; the build MUST be what rejects an incorrect one. A cut leaving a collection with anything but exactly one folder group, with a patch-shaped line name, with a line numbered above the folder group, or with folders and manifest entries that do not correspond MUST fail the build. The number of lines a cut leaves behind SHALL NOT be a reason to reject it.

A command MAY be provided that performs the whole cut for one collection, and it SHALL produce exactly the edit a person would make by hand. It MUST NOT become a step anything depends on: the hand procedure stays documented, and releasing MUST NOT require it. It SHALL refuse a cut it cannot make reviewable — an unversioned collection, a version not above the line last cut, a missing development line, a destination already occupied, or a working tree that already carries changes — and it SHALL leave verification to the build rather than reporting success of its own.

#### Scenario: A cut needs no tooling

- **WHEN** an operator renames the folder group, copies it forward, updates the manifest, and adds the preserved line's index rules
- **THEN** the site builds and serves every line, with no script involved

#### Scenario: A cut made by the command is the same cut

- **WHEN** the command cuts a collection's next line
- **THEN** the result is what the hand procedure produces, and the build accepts it

#### Scenario: An unreviewable cut is refused

- **WHEN** the command is asked to cut into an occupied destination, below the line last cut, on an unversioned collection, with no development line, or over uncommitted work
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

### Requirement: A version is only written into the line that carries it

A generator that writes a page describing a release SHALL write into the development line, and SHALL refuse a version that a published line already carries. It MUST refuse before writing anything, and MUST name both the version asked for and the line last cut.

The check exists because the destination is resolved rather than named on the command line, so a run for a shipped version would otherwise overwrite that release's own record of itself and leave a tree that builds and tests clean. A published line is never regenerated, and this is what enforces it.

#### Scenario: The coming version is generated into the development line

- **WHEN** a generator is run for a version above the line last cut
- **THEN** it writes into the development line

#### Scenario: A shipped version is refused

- **WHEN** a generator is run for a version whose line has already been published
- **THEN** it refuses, names the version and the line last cut, and writes nothing
- **AND** it names the published folder to edit instead

### Requirement: The cutoff regenerates the API summary of the version being released

A cutoff SHALL regenerate the API summary of the line it is about to publish, by running the generator directly, before the cut copies that line into the collection. No other surface is a release's to write: the manifest and the redirects belong to the cut, and every remaining surface is derived at build time. Release notes SHALL NOT be rendered as a page; each line's sidebar entry is an external link to that minor's release.

A minor release SHALL render the API summary. A patch release SHALL render nothing and cut nothing, because the public API is frozen at the minor boundary.

#### Scenario: A minor renders the API summary

- **WHEN** a minor release is documented
- **THEN** the API summary of the line being published is rendered, before the cut copies it

#### Scenario: A patch changes no documentation

- **WHEN** a patch release is documented
- **THEN** no page is rendered and no line is cut

#### Scenario: A release does not touch the cut's inputs

- **WHEN** a release is documented
- **THEN** neither the version manifest nor the redirects are modified by the generator

### Requirement: The currency marker follows the cut

Where a page states in its own text that it belongs to the current line, that statement SHALL be maintained by the cut, which is the only event that changes which line is current. A cut MUST clear the marker from the line it preserves and carry it, with the new line's number, onto the line it opens.

The development line SHALL carry no marker, since it is not published. A generator rendering into it MUST NOT add one, and MUST NOT remove the marker the cut sets on the line it publishes.

#### Scenario: The preserved line stops claiming to be current

- **WHEN** a line is preserved by a cut
- **THEN** its pages no longer carry the marker

#### Scenario: The opened line carries the marker with its own number

- **WHEN** a line is opened by a cut
- **THEN** its pages carry the marker and name the new line

#### Scenario: Regenerating the development line adds no marker

- **WHEN** a page of the development line is regenerated
- **THEN** it carries no marker, and gains one only when the cut publishes it

