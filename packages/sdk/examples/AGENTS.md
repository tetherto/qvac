# SDK examples

Examples are standalone, copyable user documentation.

- Use the public SDK API and include complete resource cleanup.
- Handle failures explicitly and return a failing process status for caught errors.
- Keep status output distinct from result output; follow the established `▸` status
  and `✖` error prefixes in neighboring examples.
- Keep download progress readable instead of dumping raw progress objects.
- Avoid shared helpers that make a single example incomplete when copied.
- Update examples in place when the demonstrated API changes.
