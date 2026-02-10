# qvac

The `qvac` package provides the command-line interface for the QVAC ecosystem. [API Reference](https://www.npmjs.com/package/@qvac/cli).

- Provides `npx qvac` for quick access to QVAC tooling without global installation.
- Bundles [`@qvac/cli`](https://www.npmjs.com/package/@qvac/cli), the full CLI implementation with all commands.
- Includes the `bundle sdk` command for generating tree-shaken Bare worker bundles with only the plugins you need.
- Supports automatic plugin detection from `qvac.config.*` or bundles all built-in plugins by default.

## Quick Start

```bash
# Bundle your QVAC app with default settings
npx qvac bundle sdk

# Bundle for specific platforms
npx qvac bundle sdk --host darwin-arm64 --host linux-x64
```

## Installation

For repeated use, install the CLI globally:

```bash
npm i -g @qvac/cli
qvac bundle sdk
```

## Documentation

See [@qvac/cli](https://www.npmjs.com/package/@qvac/cli) for full command reference and configuration options.

## License

Apache-2.0
