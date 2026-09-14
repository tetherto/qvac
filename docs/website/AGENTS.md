# Documentation website guidance

Use [`README.md`](README.md), the current manifest, and website configuration as the
source of truth for the framework, build, and deployment behavior.

- Write user-facing content in English.
- Keep source changes under this package and documentation content under
  `content/`, following the existing structure.
- Rewrite pages in place when guidance changes. Remove superseded instructions
  instead of accumulating corrections or chat-derived notes.
- Keep examples executable, public-facing, and free of private infrastructure or
  internal document identifiers.
- Run the narrowest relevant generation, formatting, link, and build checks from
  this package's manifest before handoff.
