## MODIFIED Requirements

### Requirement: A cut changes which line the version-less paths serve, not the paths themselves

When a new line becomes current, the version-less paths SHALL serve it, and the previous current line's pages SHALL become reachable at their versioned paths. A retired line's versioned paths MUST redirect to the same path in the current line, and its root to the collection's root, so a bookmark lands on the current documentation.

#### Scenario: Version-less paths follow the current line

- **WHEN** `v0.24` becomes the SDK's current line and `/sdk/js-ts-sdk/` is requested
- **THEN** it serves the `v0.24` JS/TS SDK page

#### Scenario: The previous line becomes addressable

- **WHEN** `v0.24` becomes current
- **THEN** the previous JS/TS SDK page is reachable at `/sdk/v0.23/js-ts-sdk/`

#### Scenario: A retired line redirects to the current line

- **WHEN** `v0.21` is retired and `/sdk/v0.21/js-ts-sdk/` is requested
- **THEN** it redirects to `/sdk/js-ts-sdk/`
