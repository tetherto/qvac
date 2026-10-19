## MODIFIED Requirements

### Requirement: Published pages state their line in the rendered text

Version applicability SHALL survive a page being read apart from the site. Every page of a versioned collection MUST state its documentation line in what it renders and in what it serves, so neither a reader nor an agent has to infer the release from the URL — which, for the current line, carries no version at all.

The rendered page SHALL state it as a label rather than a sentence in the prose. Nothing MUST be injected into a page's content to state its release. The guarantee for a page carried away from the site rests on the page's Markdown, which is what the page's own copy control copies and what every corpus concatenates; that Markdown states the line in its front matter whether or not the prose mentions it.

#### Scenario: The rendered page carries the line

- **WHEN** a versioned page is rendered
- **THEN** it states the documentation line it belongs to

#### Scenario: The line travels with the page's Markdown

- **WHEN** a versioned page's Markdown is copied from the page or fetched directly
- **THEN** it states the documentation line, with no reliance on the prose

#### Scenario: The prose does not restate the line

- **WHEN** a versioned page is rendered
- **THEN** its content carries no injected statement of the release, in either representation
