## MODIFIED Requirements

### Requirement: The inventory covers the SDK, Python, CLI, and provider packages

The inventory SHALL publish entries for `@qvac/sdk`, the Python client, `@qvac/cli`, and `@qvac/ai-sdk-provider`. Each MUST carry at least its two most recent released versions, and MUST NOT drop a version page it has already published. Coverage is a floor rather than a window: an entry grows as releases accumulate and never shrinks, so a version page keeps resolving for as long as its entry exists. A package with only one release published SHALL carry one version, and MUST gain its second at its next minor release with no new structure.

#### Scenario: A package with two releases carries two versions

- **WHEN** a package has published exactly two minor releases
- **THEN** its entry documents both, each listed on its index

#### Scenario: A third release is added, not swapped in

- **WHEN** a package that already documents two versions publishes a third
- **THEN** its entry gains a page for the new version and keeps the pages it had
- **AND** every version page published before the release still resolves at the path it was published at

#### Scenario: A package with one release carries one version

- **WHEN** a package has published only one release
- **THEN** its index lists one version, and nothing about the entry differs otherwise

#### Scenario: The Python client tracks the SDK's numbers

- **WHEN** the Python client's versions are enumerated
- **THEN** they carry the SDK's numbers, because its version is stamped from the SDK
