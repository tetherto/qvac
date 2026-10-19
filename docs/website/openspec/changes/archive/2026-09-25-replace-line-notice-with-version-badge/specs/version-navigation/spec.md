## ADDED Requirements

### Requirement: A versioned page labels its release on the breadcrumb row

Every page of a versioned collection SHALL carry a label naming the documentation line it belongs to. The label MUST sit on the breadcrumb row, aligned to its right edge, and MUST read the line's version and nothing else — the collection is named to its left by the trail, and by the collection bar and the sidebar where there is no trail.

The label MUST appear on a page of a versioned collection that renders no trail, which is every collection index and every line index. On such a page the row holds the label alone.

#### Scenario: A page inside a documentation line is labelled

- **WHEN** a page of a versioned collection is rendered
- **THEN** the right of its breadcrumb row names that page's documentation line

#### Scenario: A versioned index with no trail is still labelled

- **WHEN** a collection index or a line index of a versioned collection is rendered
- **THEN** the row holds the label with no trail beside it

#### Scenario: An unversioned collection carries no label

- **WHEN** a page of a collection that publishes no documentation lines is rendered
- **THEN** it carries no label, and no row is rendered where it would have no trail either

#### Scenario: An inventory page carries no label

- **WHEN** a page cataloguing a release of an inventory package is rendered
- **THEN** it carries no label, because it catalogues a release rather than documenting a line

### Requirement: The label says whether the release is the current one

The label SHALL distinguish the current documentation line from every past one. The current line MUST be emphasised in the brand colour and every past line MUST be drawn neutrally, so a reader on outdated documentation is told so without reading.

Because colour alone cannot carry that meaning, the label's accessible name MUST state it in words. The version number alone does not say whether it is current, so a reader who cannot distinguish the two treatments MUST be given the standing as text.

#### Scenario: The current line is emphasised

- **WHEN** a page of the line served at the collection's version-less paths is rendered
- **THEN** its label is drawn in the brand colour

#### Scenario: A past line is neutral

- **WHEN** a page of a line other than the current one is rendered
- **THEN** its label is drawn neutrally, in the treatment shared by every past line

#### Scenario: The standing is available as text

- **WHEN** a label is read by assistive technology, or by anything that keeps only the page's text
- **THEN** it states in words whether the release is the current one

### Requirement: The label is a statement, not a control

The label SHALL offer no navigation. It MUST NOT be a link or a button. Changing line remains the switcher's job alone, so that one control answers "how do I change version" and the reader is never offered a second one that behaves differently.

#### Scenario: The label cannot be followed

- **WHEN** a labelled page is rendered
- **THEN** its label carries no link and no control

#### Scenario: Changing line stays with the switcher

- **WHEN** a reader on a past line wants the current release
- **THEN** the switcher is what takes them there, including from a page that line does not have

### Requirement: The breadcrumb row is asserted against the built pages

The row SHALL be checked against the rendered HTML, as one check covering both what it holds: a gate that located the row by its own rule for each would eventually disagree with the other about which element the row is.

The check MUST cover which pages carry a label, which carry none, that the label names the page's own line, that the current line and a past one are drawn differently, and that the standing is present as text. It MUST also assert that no versioned page's Markdown carries an injected statement of its release.

#### Scenario: A label naming the wrong line fails

- **WHEN** a built page's label names a line other than the page's own
- **THEN** the check fails and names the page

#### Scenario: A label on an unversioned page fails

- **WHEN** a built page of a collection publishing no lines carries a label
- **THEN** the check fails and names the page

#### Scenario: A reinjected sentence fails

- **WHEN** a built page's Markdown states its release in its prose
- **THEN** the check fails and names the page
