## MODIFIED Requirements

### Requirement: Each versioned collection tracks one package

Versioning SHALL be a property of a collection, not of the site. Every user-facing software — declared by a versions file of kind `user-facing` — SHALL have exactly one versioned collection, however many user-facing software there are. Ecosystem and Resources MUST NOT be versioned as collections. A versioned collection MUST track exactly one package, and its line numbers MUST be that package's major and minor. Today:

- the SDK tracks `@qvac/sdk`;
- the CLI tracks `@qvac/cli`.

A versioned collection MUST be named after the package it tracks, so that the thing being versioned and the thing being named are the same.

#### Scenario: Versioned collections carry a line, unversioned ones do not

- **WHEN** the published site is enumerated
- **THEN** every page of a versioned collection belongs to a documentation line
- **AND** no Ecosystem or Resources page belongs to a collection line

#### Scenario: Adding a user-facing software adds a collection

- **WHEN** a versions file of kind `user-facing` is added and its slot is declared in the collection order
- **THEN** a versioned collection is published with its lines and its switcher, and no other site code changes

#### Scenario: A line number matches its package release

- **WHEN** a documentation line of the SDK is published
- **THEN** its number is the major and minor of an `@qvac/sdk` release

#### Scenario: The SDK is one collection across language interfaces

- **WHEN** the SDK collection is enumerated
- **THEN** the JavaScript, Python, Kotlin, and Swift interfaces are documented inside the same collection and the same documentation line
- **AND** no language interface creates a collection or a line of its own

#### Scenario: The CLI is one collection across its functions

- **WHEN** the CLI collection is enumerated
- **THEN** the model provider, SDK bundling, configuration, and the requirements check are documented inside the same collection and the same documentation line

### Requirement: A documentation line is one folder holding a complete page tree

A documentation line SHALL be the complete page tree of its software as it stands at one pinned commit. Its pages, navigation, examples, and generated data MUST all come from that commit. A line MUST be materialized into exactly one folder under its collection before the build, and that folder MUST hold every page the collection publishes for that line.

#### Scenario: A line owns a complete page tree

- **WHEN** a materialized line folder is enumerated
- **THEN** it contains every page the collection publishes for that line
- **AND** no page of that line resolves outside the folder

#### Scenario: A line's examples are its own

- **WHEN** an example changes on `main` after a line was pinned
- **THEN** that line still renders the example as it stood at its pinned commit

### Requirement: The current line is a folder group and the others are version folders

The current line SHALL be the first line its versions file declares. Materialization MUST write the current line as a Fumadocs folder group, `(v<major>.<minor>)`, so its pages keep the collection's version-less paths, and every other line as `v<major>.<minor>`. Exactly one folder group MUST exist per versioned collection after materialization. No folder MUST be renamed by hand to change currency.

#### Scenario: The current line is served at version-less paths

- **WHEN** the SDK's versions file declares `v0.24` first
- **THEN** its pages resolve at `/sdk/<page>/`
- **AND** every other declared line resolves at `/sdk/<version>/<page>/`

#### Scenario: Currency moves with the declaration

- **WHEN** a new line is declared first
- **THEN** it takes the version-less paths on the next build, with no folder renamed by hand

### Requirement: A version manifest declares every documented software and its lines

The site SHALL carry one versions file per documented software under `docs/website/versions/`. Each file MUST name:

- the package;
- its kind (collection or package);
- the repository, when the software lives outside the monorepo;
- the paths that make up a line;
- the versions retired;
- every published line with its version, the ref it follows, and the commit it is pinned to.

Together the files SHALL be the single source every version-shaped surface reads.

#### Scenario: A versions file pins every line

- **WHEN** a versions file is read
- **THEN** each line entry carries a version, a ref, and a commit

#### Scenario: Derived surfaces read the versions files

- **WHEN** the switcher, the canonical URLs, `versions.json`, the page metadata, or the retrieval filters are produced
- **THEN** each is computed from the versions files rather than by scanning content

### Requirement: The manifest and the line folders must agree

The build SHALL fail, and name the offending line, when:

- a declared line's commit does not contain its documentation folder;
- a declared line is not materialized;
- a materialized folder has no declaration.

A line MUST NOT be published by a folder existing, and a declaration MUST NOT publish a line without content.

#### Scenario: A pin without documentation fails the build

- **WHEN** a line is pinned to a commit that has no documentation folder at the declared path
- **THEN** the build fails and names the software and the line

#### Scenario: An undeclared folder fails the build

- **WHEN** a line folder exists in the materialized tree with no declaration
- **THEN** the build fails and names the folder

### Requirement: The newest published line is the version last released

The first declared line SHALL be the version most recently released. The version being written SHALL live in the package's documentation folder on `main`, which the production site does not publish. A reader following a version-less path therefore always reaches the newest released documentation.

#### Scenario: The coming release's edits stay unpublished

- **WHEN** a feature pull request edits a package's documentation on `main`
- **THEN** no production page changes until a line is pinned to a commit that contains the edit

#### Scenario: A collection whose package is not released keeps its lines

- **WHEN** a release moves no version of a tracked package
- **THEN** that software's declared lines stay as they are

## ADDED Requirements

### Requirement: Lines are materialized from their pinned commits before the build

The build SHALL extract every declared line from its pinned commit, restricted to the declared paths, before any page is compiled. Software outside the monorepo SHALL be fetched from its declared repository. The site MUST NOT run a package's toolchain while materializing, so a line builds from committed files alone.

#### Scenario: A line is extracted from its commit

- **WHEN** the site is built
- **THEN** each line's pages, navigation, examples, and generated data are read from that line's pinned commit

#### Scenario: Software in another repository is materialized

- **WHEN** a versions file declares a repository
- **THEN** its lines are fetched from that repository at their pinned commits

### Requirement: A build can substitute a line for preview

Materialization SHALL accept an override that replaces one declared line with a working tree or another commit, and an option that adds the unreleased line from `main`. A pull request MUST be able to preview its own documentation inside the current site this way:

- a pull request into `main` previews the unreleased line from its working tree;
- a pull request into a release branch is built with the site from `main` and its head substituted for its line.

#### Scenario: A pull request into a release branch is previewed

- **WHEN** a pull request edits a released line's documentation on its release branch
- **THEN** its preview renders the current site with that line taken from the pull request's head

#### Scenario: The unreleased line is previewed on staging

- **WHEN** the site is built with the unreleased-line option
- **THEN** the unreleased line is rendered from `main` and never reaches production

### Requirement: A line is published until it is retired by hand

No number of published lines SHALL be imposed. A line SHALL stay published until it is retired. Retiring a line MUST be one edit to its versions file: moving the version from `lines` to `retired`. The build MUST then stop publishing the line and redirect its addresses to the current line, with no other file edited.

#### Scenario: A new line retires nothing

- **WHEN** a software publishing three lines gains a fourth
- **THEN** all four lines are published

#### Scenario: Retiring a line is one edit

- **WHEN** a pull request moves `v0.16` from `lines` to `retired` in `versions/sdk.json`, and touches nothing else
- **THEN** the build no longer publishes `v0.16`
- **AND** every `/sdk/v0.16/…` address redirects to the same path in the current line

### Requirement: Line redirect rules are generated from the versions files

The redirect rules of every published line that is not current, and of every retired line, SHALL be generated from the versions files at build. No line's rules MUST be written by hand in `public/_redirects`. That file SHALL carry only the markers where the generated rules are expanded, so their position among the other rules is kept.

#### Scenario: A pinned line gets its rules without a redirects edit

- **WHEN** a line is added to a versions file
- **THEN** the exported `_redirects` carries its rules, and `public/_redirects` is unchanged

## REMOVED Requirements

### Requirement: A versioned collection publishes every line it has cut

**Reason**: A line is now withdrawn when the team stops supporting its version, not kept forever.
**Migration**: Use "A line is published until it is retired by hand" and the retired-line redirect in `versioned-urls`.
