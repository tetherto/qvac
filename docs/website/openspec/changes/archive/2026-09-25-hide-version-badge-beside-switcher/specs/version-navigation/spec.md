## MODIFIED Requirements

### Requirement: A versioned page labels its release on the breadcrumb row

Every page of a versioned collection SHALL carry a label naming the documentation line it belongs to. The label MUST sit on the breadcrumb row, aligned to its right edge, and MUST read the line's version and nothing else — the collection is named to its left by the trail, and by the collection bar and the sidebar where there is no trail.

The label SHALL be shown only at the viewports where the sidebar is not rendered. Where the sidebar is rendered, the switcher at its top already names the line, and the label would state the same release twice on one screen. The viewports at which this applies MUST be the sidebar's own, taken from the sidebar rather than declared again for the label, so the two cannot come to disagree about where the switcher is.

The label MUST remain in the page's markup at every viewport, hidden rather than omitted. A statically exported page cannot know the viewport it will be read at, and the label's text is what keeps the release in the page's text for anything that reads the page as text.

The label MUST appear on a page of a versioned collection that renders no trail, which is every collection index and every line index. On such a page the row holds the label alone, and the row is shown only where the label is.

#### Scenario: A page inside a documentation line is labelled

- **WHEN** a page of a versioned collection is rendered at a viewport with no sidebar
- **THEN** the right of its breadcrumb row names that page's documentation line

#### Scenario: The switcher's viewports carry no label

- **WHEN** a page of a versioned collection is rendered at a viewport where the sidebar is shown
- **THEN** the label is not displayed, and the line is named by the switcher alone

#### Scenario: The label is in the page whether or not it is shown

- **WHEN** a versioned page's markup is read
- **THEN** it carries the label and its standing, at every viewport

#### Scenario: A versioned index with no trail is still labelled

- **WHEN** a collection index or a line index of a versioned collection is rendered at a viewport with no sidebar
- **THEN** the row holds the label with no trail beside it

#### Scenario: A row holding only a hidden label is not shown

- **WHEN** a collection index or a line index is rendered at a viewport where the sidebar is shown
- **THEN** no row appears above its heading

#### Scenario: An unversioned collection carries no label

- **WHEN** a page of a collection that publishes no documentation lines is rendered
- **THEN** it carries no label, and no row is rendered where it would have no trail either

#### Scenario: An inventory page carries no label

- **WHEN** a page cataloguing a release of an inventory package is rendered
- **THEN** it carries no label, because it catalogues a release rather than documenting a line

### Requirement: The breadcrumb row is asserted against the built pages

The row SHALL be checked against the rendered HTML, as one check covering both what it holds: a gate that located the row by its own rule for each would eventually disagree with the other about which element the row is.

The check MUST cover which pages carry a label, which carry none, that the label names the page's own line, that the current line and a past one are drawn differently, and that the standing is present as text. It MUST also assert that no versioned page's Markdown carries an injected statement of its release.

The check SHALL derive the viewports the label is hidden at from the sidebar in the same built page, and MUST require the label to be hidden at exactly those and shown at every other. The coupling MUST NOT be expressed as a constant the check carries, because the sidebar's breakpoint belongs to the documentation framework: a framework change to it would otherwise leave the label wrong on one band of viewports with nothing failing.

#### Scenario: A label naming the wrong line fails

- **WHEN** a built page's label names a line other than the page's own
- **THEN** the check fails and names the page

#### Scenario: A label on an unversioned page fails

- **WHEN** a built page of a collection publishing no lines carries a label
- **THEN** the check fails and names the page

#### Scenario: A reinjected sentence fails

- **WHEN** a built page's Markdown states its release in its prose
- **THEN** the check fails and names the page

#### Scenario: A sidebar that moves its breakpoint fails

- **WHEN** the built sidebar is hidden at a different set of viewports than the label is shown at
- **THEN** the check fails and names both, rather than passing on a breakpoint it no longer matches

#### Scenario: A label shown beside the switcher fails

- **WHEN** a built label carries no condition hiding it where the sidebar is rendered
- **THEN** the check fails and names the page
