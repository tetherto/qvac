# versioned-urls Specification

## Purpose
TBD - created by archiving change version-docs-by-collection. Update Purpose after archive.
## Requirements
### Requirement: The current line is served at the collection's version-less paths

Because the current line's folder is a folder group, its pages SHALL keep the collection's paths with no version segment in them. Introducing versioning MUST therefore change no URL that the site publishes today.

#### Scenario: A current-line page keeps its URL

- **WHEN** the JS/TS SDK page of the current line is requested
- **THEN** it resolves at `/sdk/js-ts-sdk/`, the URL it had before versioning

#### Scenario: The collection root serves the current line

- **WHEN** `/sdk/` is requested
- **THEN** it serves the index of the current line

### Requirement: Other lines carry their version in the URL

A page in a line other than the current one SHALL be published at `/{collection}/v{major}.{minor}/{page}`. The version segment MUST use the `v` prefix and MUST carry only major and minor.

#### Scenario: A non-current line page carries its segment

- **WHEN** the JS/TS SDK page of line `v0.18` is requested
- **THEN** it resolves at `/sdk/v0.18/js-ts-sdk/`

#### Scenario: A segment without the `v` prefix is not a line

- **WHEN** `/sdk/0.18/js-ts-sdk/` is requested
- **THEN** it does not resolve to a page of the `v0.18` line

#### Scenario: A segment carrying a patch or a series suffix is not a line

- **WHEN** `/sdk/v0.18.2/js-ts-sdk/` or `/sdk/v0.18.x/js-ts-sdk/` is requested
- **THEN** neither resolves to a page of the `v0.18` line

### Requirement: Version segments are linked in the trailing-slash form the CDN serves

Every page URL is served in its trailing-slash form, because the CDN normalizes slash-less paths to it. That normalization is skipped when the final segment contains a dot, which a version segment always does, so the site MUST supply for those paths what the CDN would otherwise do: serve the trailing-slash form, and redirect the slash-less form to it. Every link and generated URL targeting a non-current line SHALL be emitted in the trailing-slash form directly, rather than relying on a fix-up.

#### Scenario: Generated URLs carry the trailing slash

- **WHEN** the switcher, the sidebar, or a generated surface emits a URL for a non-current line
- **THEN** the URL ends with a slash

#### Scenario: The trailing-slash form is served

- **WHEN** `/sdk/v0.18/` is requested
- **THEN** the line's index is served, without a redirect

#### Scenario: The slash-less form redirects to it

- **WHEN** `/sdk/v0.18` is requested
- **THEN** the site redirects to `/sdk/v0.18/`
- **AND** the request does not end on the slash-less form again

### Requirement: A page is canonical for its own line

The URL a page is served at SHALL be its canonical location. A page of the current line MUST be canonical at its version-less path, and a page of another line MUST be canonical at its versioned path rather than pointing at the current line.

#### Scenario: The current line is canonical at its version-less path

- **WHEN** a current-line page is rendered
- **THEN** its canonical URL carries no version segment

#### Scenario: Another line is canonical for itself

- **WHEN** a page of a non-current line is rendered
- **THEN** its canonical URL carries that line's version segment

### Requirement: A cut changes which line the version-less paths serve, not the paths themselves

When a release cuts a new line, the version-less paths SHALL serve it, and the previous line's pages SHALL become reachable at their versioned paths. No page URL is retired by a cut, so a reader who bookmarked a version-less URL keeps landing on current documentation and can reach the previous release explicitly.

#### Scenario: Version-less paths follow the current line

- **WHEN** `v0.19` is cut and `/sdk/js-ts-sdk/` is requested
- **THEN** it serves the `v0.19` JS/TS SDK page

#### Scenario: The previous line becomes addressable

- **WHEN** `v0.19` is cut
- **THEN** the previous JS/TS SDK page is reachable at `/sdk/v0.18/js-ts-sdk/`

#### Scenario: A cut retires no URL

- **WHEN** the URL set published before a cut is replayed after it
- **THEN** every URL resolves

