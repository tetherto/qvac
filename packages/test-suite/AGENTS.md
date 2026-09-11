# Test-suite guidance

Treat [`README.md`](README.md), `package.json`, public entry points, schemas, and
tests as authoritative. This package is the test orchestration framework; consumer
test definitions live outside it.

- Protect CLI behavior, package exports, configuration and message contracts,
  mobile templates, and producer/consumer/report lifecycle semantics.
- Keep the Node/desktop and reduced mobile entry points intentionally separate.
- Do not commit generated `dist/` output or assume it exists in a clean checkout.
- Preserve compatibility aliases only while source and tests still declare them;
  do not copy the current alias list into instructions.
- Update [`docs/architecture.md`](docs/architecture.md) in place when framework
  architecture changes.
- Run the package-owned check, build, and focused test scripts before handoff.
