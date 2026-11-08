## ADDED Requirements

### Requirement: API facts are extracted from the software, never written by hand

Every API fact the site renders SHALL be extracted deterministically from the software's own machine-readable surface:

- types, nesting, required flags, defaults, enumerations, constraints, field descriptions, call shapes, and signatures;
- available models;
- commands and options;
- HTTP operations.

Prose MAY explain a fact, but MUST NOT restate it. Each kind of software SHALL use its strongest source:

| Software | Source |
|---|---|
| SDK and Compose | their exported contract |
| Internal packages | their public type declarations |
| CLI | its command tree |
| HTTP server | its OpenAPI document |
| Models | the model registry |

#### Scenario: A parameter table comes from the contract

- **WHEN** an SDK capability page renders its inputs
- **THEN** every field, type, required flag, default, and description comes from the SDK contract

#### Scenario: A model list comes from the registry

- **WHEN** a capability page lists its models
- **THEN** the list is produced from the model registry, filtered by the capability's engines

#### Scenario: A CLI option is documented from its definition

- **WHEN** a CLI command's reference is rendered
- **THEN** each option's flags, description, default, and choices are the ones the command defines for its help output

### Requirement: Generated API data is committed in the package and kept fresh

Any extraction that needs a package's toolchain SHALL run in the package, and its output SHALL be committed with the package's documentation. A freshness check MUST fail a pull request whose committed data no longer matches the source. The site build MUST read committed data only.

#### Scenario: Stale generated data fails the pull request

- **WHEN** a pull request changes a public type without regenerating the package's API data
- **THEN** the freshness check fails and names the package

#### Scenario: The site runs no package toolchain

- **WHEN** an old line is materialized and built
- **THEN** its API data is read from the committed files at its pinned commit

### Requirement: Nested types are rendered to primitives

A rendered parameter or return type SHALL be expandable down to primitive types. Objects, unions of literals, arrays, and overloads MUST be expanded. A type the extraction cannot expand MUST be shown as its declared type text, linked to its declaration, rather than omitted.

#### Scenario: A nested object is expandable

- **WHEN** a reader expands an object-typed field
- **THEN** its own fields appear with their types, required flags, defaults, and descriptions

#### Scenario: An unexpandable type is shown as declared

- **WHEN** a field's type cannot be expanded
- **THEN** its declared type text is shown with a link to the declaration

### Requirement: The polyglot SDK has one reference with a language switcher

The SDK reference SHALL be one reference for every language. Its parts:

- **field tables** are language-agnostic, and the reader's chosen language renames fields by that language's naming rule;
- **signature cards and examples** are shown per language, from each language's real public surface.

A parity check MUST fail when a contract method is missing from a published language.

#### Scenario: Field names follow the chosen language

- **WHEN** a reader switches the SDK reference from JavaScript to Python
- **THEN** `modelId` reads `model_id`, and the field set and descriptions are unchanged

#### Scenario: A missing method fails parity

- **WHEN** a contract method has no counterpart in a published language
- **THEN** the parity check fails and names the method and the language

### Requirement: Agents receive compact API projections

Each line's agent corpus SHALL include one compact card per public function: its signature with expanded types and field descriptions. The site SHALL also publish each method's JSON Schema separately, so an agent can fetch one method without the whole contract.

#### Scenario: A function card is in the corpus

- **WHEN** an agent reads a line's corpus
- **THEN** each public function appears once as a compact card with its expanded parameter types

#### Scenario: One method's schema is fetchable alone

- **WHEN** an agent requests the schema of one method of a line
- **THEN** it receives that method's request and response schema only

### Requirement: Function descriptions keep a short in-code summary

A public function's in-code documentation SHALL be limited to a short summary and its deprecation, throws, and status tags. These are the only in-code comments the documentation reads. Field descriptions MUST come from the schemas or type declarations. Examples MUST come from runnable example files.

#### Scenario: Parameter tags are not read

- **WHEN** a function carries parameter tags in its in-code documentation
- **THEN** the rendered reference ignores them and takes field descriptions from the schema

#### Scenario: A public request field lacks a description

- **WHEN** a public request field in the SDK contract has no description
- **THEN** the description check fails and names the field
