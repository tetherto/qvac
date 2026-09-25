# versioned-agent-artifacts Specification

## Purpose
TBD - created by archiving change version-docs-by-collection. Update Purpose after archive.
## Requirements
### Requirement: Agent artifacts form a three-level hierarchy

The site SHALL publish `llms.txt` at three levels: a root router listing the collections, a collection resolver listing that collection's lines, and a line index listing that line's pages. Each level MUST point at the next rather than restating it, so an agent reaches a single line's page list in three steps.

#### Scenario: The root routes to collections

- **WHEN** `/llms.txt` is fetched
- **THEN** it lists the collections and, for each versioned one, points at its resolver

#### Scenario: The collection resolver lists its lines

- **WHEN** the SDK collection resolver is fetched
- **THEN** it lists `v0.19` and `v0.18`, marks the current one, and links each line's index

#### Scenario: The line index lists that line's pages

- **WHEN** an SDK line index is fetched
- **THEN** it lists only pages of that line

### Requirement: Each line publishes an isolated full corpus

Each documentation line SHALL publish its own `llms-full.txt` containing the full text of that line's pages, excluding release notes, and no page of any other line. The current line's corpus MUST be served at the collection's version-less path and another line's at its versioned path.

Release notes are withheld from every corpus. They are historical changelogs whose bulk inflates the token count without adding context needed to use the release. They remain listed in the line's index and fetchable one page at a time, so nothing a corpus withholds is unreachable.

#### Scenario: The current line's corpus is at the version-less path

- **WHEN** `/sdk/llms-full.txt` is fetched
- **THEN** it contains the full text of every current-line SDK page and no page of another line

#### Scenario: Another line's corpus is at its versioned path

- **WHEN** `/sdk/v0.18/llms-full.txt` is fetched
- **THEN** it contains only `v0.18` pages

#### Scenario: The root corpus does not mix lines

- **WHEN** a site-wide corpus is published
- **THEN** it contains the unversioned collections and, for each versioned collection, only the current line

#### Scenario: Release notes are withheld from a corpus

- **WHEN** a corpus is fetched, whether line-scoped or site-wide
- **THEN** it carries no release-notes page, and that page remains listed in the line's index and fetchable on its own

### Requirement: A corpus is reached through `llms.txt`, not from the page

A line's corpus SHALL be discoverable only by following the `llms.txt` hierarchy, which resolves the collection and the line before naming a corpus URL. No page-level control may link a corpus, so no control can offer a reader on one line the corpus of another.

#### Scenario: The hierarchy names the corpus

- **WHEN** an agent follows `llms.txt` from the root to a line
- **THEN** it reaches that line's `llms-full.txt` URL

#### Scenario: No page control links a corpus

- **WHEN** a page is rendered
- **THEN** none of its controls links `llms-full.txt`

### Requirement: Each versioned collection publishes a machine-readable line index

Each versioned collection SHALL publish a `versions.json` naming its published lines, which one is current, and the package it tracks. It MUST be generated from the version manifest, which the build has already checked against the line folders, so it cannot contradict what is published.

#### Scenario: The line index reflects what is declared

- **WHEN** `versions.json` is fetched for the SDK
- **THEN** it lists exactly the published lines, marks the folder-group line as current, and names `@qvac/sdk`

#### Scenario: A new line appears without editing the artifact

- **WHEN** a line is added and the site is rebuilt
- **THEN** `versions.json` lists it, with no edit to the artifact or its route

### Requirement: The Markdown of a page states its documentation line

The Markdown the site already publishes for every page SHALL additionally state the collection, the documentation line, the tracked package, whether the line is current, and the canonical URL. The metadata MUST be derived at build time from the page's location, never hand-written in frontmatter.

#### Scenario: Markdown states its line

- **WHEN** the Markdown of an SDK page is fetched
- **THEN** it states the collection, the line, the tracked package, whether the line is current, and the canonical URL

#### Scenario: Metadata cannot drift from location

- **WHEN** a page is moved into a different line
- **THEN** its Markdown metadata changes with it, with no edit to the page

#### Scenario: Unversioned pages say so

- **WHEN** the Markdown of an Ecosystem page is fetched
- **THEN** it declares no documentation line

### Requirement: Published pages state their line in the rendered text

Version applicability SHALL survive copy-paste. Every page of a versioned collection MUST state its documentation line in the rendered content, so an agent given only the text can tell which release it applies to.

#### Scenario: The rendered page carries the line

- **WHEN** a versioned page is rendered
- **THEN** its text states the documentation line it belongs to

### Requirement: The site publishes a corpus protocol for coding agents

The site SHALL publish instructions telling a coding agent how to pick a corpus: read the target project's installed package version, resolve the matching line, and fetch that line's artifacts. It MUST state what to do when no line matches — use the nearest older line and say so.

#### Scenario: The protocol is discoverable

- **WHEN** the root `llms.txt` is fetched
- **THEN** it links the corpus protocol

#### Scenario: The protocol covers a missing line

- **WHEN** a project uses a release no published line covers
- **THEN** the protocol directs the agent to the nearest older line and to disclose the substitution

### Requirement: Agent artifacts are gated against cross-line leakage

Cross-line leakage SHALL fail the build. A line-scoped artifact MUST NOT reference a URL belonging to another line of a versioned collection; it MAY reference unversioned pages of any collection, and MAY reference another versioned collection at that collection's current line. Every URL it lists MUST resolve.

#### Scenario: A URL from another line fails the build

- **WHEN** a line's artifact lists a URL belonging to another line of a versioned collection
- **THEN** the build fails and names the artifact and the URL

#### Scenario: Unversioned URLs are allowed

- **WHEN** a line's artifact lists an Ecosystem or Resources URL
- **THEN** the check passes

#### Scenario: Another versioned collection is referenced at its current line

- **WHEN** an SDK line's artifact references the CLI
- **THEN** it uses the CLI's version-less path, and the check passes

#### Scenario: Artifacts have no dead links

- **WHEN** the artifacts are read to detect leakage
- **THEN** the same pass resolves every URL they list against the built page set, because the HTML broken-link step never opens them

### Requirement: A corpus declares its own scope before its content

Every corpus SHALL open with a block stating what it carries, so a reader holding the corpus alone can tell which documentation it is reading without resolving anything else. The block MUST name the collection and line the corpus covers, the package and release those track, the number of pages it carries, and the release-notes exclusion together with how to reach an excluded page. A line corpus MUST also offer a reader on the wrong line a way to the right one, and MUST do so through the collection's resolver or its machine-readable line list, never by naming another line's URL, which the leakage gate forbids a line-scoped artifact.

The declaration is prose for a reader that arrived without the hierarchy. It does not replace `versions.json`, which stays the machine-readable face of the line structure.

#### Scenario: A line corpus states which line it is

- **WHEN** a line's `llms-full.txt` is fetched
- **THEN** its opening block names the collection, the line, the tracked package, and whether that line is current

#### Scenario: The corpus accounts for what its index counts

- **WHEN** a line index reports a page total and names the line's corpus
- **THEN** the corpus states how many pages it carries and why that differs from the index's total

#### Scenario: A withheld page is reachable from the corpus that withheld it

- **WHEN** a corpus declares the release-notes exclusion
- **THEN** it names the page to fetch for the release notes it left out

#### Scenario: A line corpus routes to another line without naming it

- **WHEN** a corpus of a non-current line is fetched
- **THEN** its opening block points at the collection's resolver and machine-readable line list, and names no URL of another line

#### Scenario: An undeclared corpus fails the build

- **WHEN** a corpus is published without an opening block declaring its scope
- **THEN** the build fails and names the corpus

