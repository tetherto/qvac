## MODIFIED Requirements

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

## ADDED Requirements

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
