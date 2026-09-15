# Registry server guidance

Treat this package's source, `package.json`, README, and files under `docs/` as the
current authority. Use the `qv-registry-autobase-patterns` skill for Autobase,
HyperDB, multi-writer, and replication work.

- Keep JavaScript in strict mode and follow the package's established style.
- Prefix non-public methods with `_`; do not introduce private `#` methods into
  code that follows the existing compatibility convention.
- Use `ReadyResource` lifecycle methods for stateful resources where the surrounding
  implementation uses that abstraction.
- Use structured `@qvac/error` errors at public/client boundaries when available,
  preserve causes, and never log keys, tokens, or credentials.
- Comments explain non-obvious intent, constraints, or performance implications,
  not the visible mechanics of the code.
- Verify changes with the narrowest relevant scripts from this package's
  `package.json`. Do not assume another package's commands apply here.
- Update the owning README or package documentation in place when a contract or
  operational procedure changes.
