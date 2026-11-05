## ADDED Requirements

### Requirement: Each versioned collection tracks one package

Versioning SHALL be a property of a collection, not of the site. The SDK and Provider collections MUST be versioned; Platform and Resources MUST NOT. A versioned collection MUST track exactly one package, and its line numbers MUST be that package's major and minor: the SDK tracks `@qvac/sdk`, and the Provider tracks `@qvac/cli`, which implements the OpenAI-compatible HTTP server the collection documents.

#### Scenario: Versioned collections carry a line, unversioned ones do not

- **WHEN** the published site is enumerated
- **THEN** every SDK and Provider page belongs to a documentation line
- **AND** no Platform or Resources page belongs to a documentation line

#### Scenario: A line number matches its package release

- **WHEN** a documentation line of the SDK is published
- **THEN** its number is the major and minor of an `@qvac/sdk` release

#### Scenario: The SDK is one collection across language interfaces

- **WHEN** the SDK collection is enumerated
- **THEN** the JavaScript, Python, Kotlin, and Swift interfaces are documented inside the same collection and the same documentation line
- **AND** no language interface creates a collection or a line of its own

### Requirement: A documentation line is one folder holding a complete page tree

A documentation line SHALL be represented by exactly one folder directly under its collection, and that folder MUST hold every page the collection publishes for that line.

#### Scenario: A line owns a complete page tree

- **WHEN** a documentation line folder is enumerated
- **THEN** it contains every page the collection publishes for that line
- **AND** no page of that line resolves outside the folder

#### Scenario: A versioned collection has no pages outside a line

- **WHEN** a versioned collection folder is enumerated
- **THEN** every `.mdx` file under it sits inside a line folder

### Requirement: The current line is a folder group and the others are version folders

The current line's folder SHALL be named as a Fumadocs folder group, `(v<major>.<minor>)`, so it is excluded from the slug and its pages keep the collection's version-less paths. Every other line's folder MUST be named `v<major>.<minor>`, without parentheses, so its pages carry the version segment. Exactly one folder group MUST exist per versioned collection, and it MUST be what identifies the current line.

#### Scenario: The current line is served at version-less paths

- **WHEN** the SDK's current line is `v0.19` and its folder is `(v0.19)`
- **THEN** `content/docs/sdk/(v0.19)/js-ts-sdk.mdx` resolves at `/sdk/js-ts-sdk/`

#### Scenario: An older line carries its version segment

- **WHEN** the SDK also publishes `v0.18`
- **THEN** `content/docs/sdk/v0.18/js-ts-sdk.mdx` resolves at `/sdk/v0.18/js-ts-sdk/`

#### Scenario: Exactly one current line per collection

- **WHEN** a versioned collection contains zero or more than one folder group
- **THEN** the line structure check fails and names the collection

### Requirement: A version manifest declares every documented software and its lines

The site SHALL carry one manifest declaring every piece of software it documents at more than one version — the versioned collections and the inventory packages alike — naming for each the package it is, where it is documented, and the versions published. An entry SHALL record its version and the folder that holds it, and nothing else: whether a versioned collection's line is current MUST be read from the folder it names, never stated separately. An inventory package declares no current version, because every one of its versions is addressed explicitly. The manifest SHALL be the single source every version-shaped surface reads.

#### Scenario: The manifest names each software and its lines

- **WHEN** the manifest is read
- **THEN** it names each documented software, its package, where it is documented, and every line published for it
- **AND** each line entry carries its version and its folder

#### Scenario: Currency is read from the folder

- **WHEN** the current line of a versioned collection is resolved
- **THEN** it is the entry whose folder is the folder group
- **AND** no entry declares currency by any other means

#### Scenario: An inventory package has no current version

- **WHEN** an inventory package's entries are read
- **THEN** none of their folders is a folder group, and no version is marked current

#### Scenario: Derived surfaces read the manifest

- **WHEN** the switcher, the canonical URLs, `versions.json`, the page metadata, or the retrieval filters are produced
- **THEN** each is computed from the manifest rather than by scanning the content tree

### Requirement: The manifest and the line folders must agree

Publishing a line SHALL require both a line folder and a manifest entry naming it, each created by hand. The build SHALL enforce a one-to-one correspondence between them: a line folder with no entry, an entry naming a folder that does not exist, or an entry whose folder name differs from the folder on disk MUST fail the build and name the offending line. A folder MUST NOT publish itself by existing, and an entry MUST NOT publish a line that has no content.

#### Scenario: Adding a line takes both edits

- **WHEN** a line folder is created and the manifest declares it
- **THEN** its pages resolve, it appears in the switcher, and it appears in the generated surfaces

#### Scenario: An undeclared folder fails the build

- **WHEN** a line folder exists under a versioned collection with no manifest entry
- **THEN** the build fails and names the folder

#### Scenario: An entry without content fails the build

- **WHEN** the manifest declares a line whose folder is absent
- **THEN** the build fails and names the entry

#### Scenario: A rename without a manifest edit fails the build

- **WHEN** a folder group is renamed to its plain versioned form and the manifest still names the old folder
- **THEN** the build fails, rather than serving the renamed line as current

### Requirement: The current line is the version shipping next

The folder group SHALL be the version the next release will publish, and SHALL be cut in `main` as soon as the previous release is live. Between releases `main` therefore carries a line for a version that has not shipped, which is the point: every edit describing the coming release lands in the folder that will be current when it ships, so nothing is moved, renamed, or reclassified at release time. The site is deployed as part of a release, so a reader is never served the line before its version exists.

#### Scenario: The next line is cut right after a release

- **WHEN** `@qvac/sdk` `0.18` is live on the site
- **THEN** `main` renames `(v0.18)` to `v0.18` and copies it to `(v0.19)`
- **AND** the site keeps serving `v0.18` until the next release deploys

#### Scenario: The coming release's edits land in the group

- **WHEN** a page is written for the version being prepared
- **THEN** it is written in the folder group, and no move is needed when that version ships

#### Scenario: The current line is the highest number

- **WHEN** a versioned collection's lines are enumerated
- **THEN** the folder group is the highest-numbered line

#### Scenario: A product with no release scheduled is not cut

- **WHEN** the coming release includes no new version of a tracked package
- **THEN** that collection keeps the lines it has, and its group stays the version it already documents

### Requirement: Up to two documentation lines per versioned collection

A versioned collection SHALL publish the current line and, once a release has cut one, the previous line — at most two. Two is the minimum that exercises switching, fallback, canonical resolution, and corpus isolation, and the previous line starts as what the site served before the cut rather than as content written ahead of a release.

#### Scenario: The SDK publishes both of its lines

- **WHEN** the content tree is enumerated after this change ships with `@qvac/sdk` `0.19`
- **THEN** the SDK publishes `(v0.19)` and `v0.18`
- **AND** `v0.18` starts as what the site served before the cut

#### Scenario: The Provider publishes both of its lines

- **WHEN** the content tree is enumerated after the Provider is cut
- **THEN** the Provider publishes `(v0.13)`, the release that is live, and `v0.12`, the one before it
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

### Requirement: Documentation lines do not carry patch versions

A documentation line SHALL represent every patch release in its major-minor range. A line folder MUST NOT be created for a patch release, and a line name MUST NOT carry a patch component.

#### Scenario: One line covers a whole patch range

- **WHEN** the SDK line `v0.18` is published
- **THEN** it documents `@qvac/sdk` `>=0.16.0 <0.17.0`
- **AND** no separate line exists for `0.16.0`, `0.16.1`, or any later patch in that range

#### Scenario: Patch-shaped line names are rejected

- **WHEN** the content tree is validated
- **THEN** a line folder named `v0.18.0`, `v0.18.x`, `(v0.18.0)`, or `(v0.18.x)` fails the check

### Requirement: Resources declare compatibility per entry

Because the Resources collection is not versioned, each entry SHALL declare its own compatibility rather than inheriting one from a line. An entry MUST be able to state the SDK range it supports, the versions it was tested with, when it was last verified, and its maintenance status.

#### Scenario: A resource states its own compatibility

- **WHEN** a Resources entry is published
- **THEN** its compatibility metadata is read from the entry itself
- **AND** no documentation line applies to it