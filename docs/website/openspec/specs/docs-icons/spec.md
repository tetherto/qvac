# docs-icons Specification

## Purpose

Icons in the documentation site. Where one is declared — beside the navigation entry it belongs to, which for a versioned collection means a page's frontmatter or a folder's `meta.json` — which surfaces render it, and the rule that the page being read is not one of them. Also the allowlist that bounds the icon set, and the requirement that a page carries the same icon in every line that carries the page.
## Requirements
### Requirement: An icon identifies an entry in a list, not a page the reader has reached

An icon SHALL be rendered where it distinguishes one entry from its neighbours — in the sidebar, and in any other list of pages. It MUST NOT be rendered beside the title of the page being read, where the reader has already arrived and the title alone names the page. Declaring an icon for a page SHALL therefore affect its navigation entry and nothing about the page's own heading.

#### Scenario: The sidebar entry carries the icon

- **WHEN** a page that declares an icon is listed in the sidebar
- **THEN** its entry renders that icon beside its label

#### Scenario: The page heading carries no icon

- **WHEN** a page that declares an icon is rendered
- **THEN** its heading shows the title alone, with no icon beside it

#### Scenario: Declaring an icon changes only the navigation

- **WHEN** an icon is added to a page that had none
- **THEN** the page's own heading is unchanged

### Requirement: An icon is declared where the navigation entry is declared

An icon SHALL be declared at the same place as the navigation entry it belongs to. A collection whose navigation is declared in the site source SHALL declare its icons there. A collection whose navigation is declared in its content SHALL declare a page's icon in that page's frontmatter and a folder's icon in that folder's `meta.json`. No page SHALL need an entry in the site source to carry an icon, and no icon SHALL be declared in two places for the same entry.

#### Scenario: A content-declared page declares its icon in frontmatter

- **WHEN** a page in a collection whose navigation lives in its content declares an icon
- **THEN** the icon is read from that page's frontmatter

#### Scenario: A content-declared folder declares its icon in its meta

- **WHEN** a folder in such a collection declares an icon
- **THEN** the icon is read from that folder's `meta.json`

#### Scenario: A source-declared entry declares its icon in the source

- **WHEN** a collection declares its navigation in the site source
- **THEN** each of its entries declares its icon alongside it

#### Scenario: No entry declares its icon twice

- **WHEN** the declarations are enumerated
- **THEN** no navigation entry has an icon declared in more than one place

### Requirement: A page carries the same icon in every line that carries the page

A page published in more than one documentation line SHALL be identified by the same icon in each. Switching line MUST NOT change how a page is identified in the sidebar, because the line the reader is on says which release the page documents, not which page it is. Adding or changing a page's icon SHALL therefore be applied to every line that carries the page.

#### Scenario: Switching line does not change a page's icon

- **WHEN** a reader switches from one documentation line to another
- **THEN** a page present in both is identified by the same icon in each

#### Scenario: An icon change reaches every line

- **WHEN** a page's icon is added or changed
- **THEN** every line carrying that page carries the change

### Requirement: The icon set is an allowlist, extended deliberately

An icon SHALL be named by a string, resolved against the Lucide set plus an explicit allowlist of brand marks. A brand mark MUST be added to that allowlist to be usable, so the set of icons the site can draw stays a decision rather than the surface area of a dependency. A name that resolves to nothing MUST leave the entry without an icon rather than fail the build.

#### Scenario: A Lucide name resolves

- **WHEN** an entry names an icon in the Lucide set
- **THEN** it renders that glyph

#### Scenario: A brand mark resolves only once allowlisted

- **WHEN** an entry names a brand mark present in the allowlist
- **THEN** it renders that mark

#### Scenario: A name outside both sets renders nothing

- **WHEN** an entry names an icon in neither set
- **THEN** the entry renders without an icon
- **AND** the build succeeds

### Requirement: The entries the navigation move left unidentified are identified again

Every entry that carried an icon before its collection's navigation moved into the content SHALL carry one afterwards. This covers the pages for the JS/TS client, the Python client, assessing model fit, music generation, and world simulation, and the HTTP-server folder. Each MUST be identified in the sidebar, in every line that carries it.

#### Scenario: The client pages are identified

- **WHEN** the SDK sidebar is rendered for any line
- **THEN** the JS/TS SDK and Python SDK entries each carry their language's mark

#### Scenario: The three capability and model pages are identified

- **WHEN** the SDK sidebar is rendered for any line
- **THEN** the assess-model-fit, music-generation, and world-simulation entries each carry an icon

#### Scenario: The HTTP-server folder is identified

- **WHEN** the CLI sidebar is rendered for any line
- **THEN** the HTTP-server folder entry carries an icon
- **AND** it is declared in that folder's `meta.json`, because a folder takes its icon from there and not from its index page

#### Scenario: No entry that had an icon lost it

- **WHEN** the icons declared before the navigation moved are compared against those declared after, resolving each entry to wherever its page or folder now lives
- **THEN** every entry that had one still has one

