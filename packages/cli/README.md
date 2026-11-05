# @qvac/cli

The `qvac` command. It is the entry point for QVAC packages that have a command
line, starting with the SDK tools ([`@qvac/sdk-tools`](../sdk-tools/README.md)),
which run as `qvac sdk`.

## Installation

```bash
npm i -g @qvac/cli
```

Requires Node.js `^22.21.0 || >=24.9.0`.

## Usage

```bash
qvac sdk serve --openai
qvac sdk doctor
qvac sdk bundle
qvac sdk --help
```

`qvac sdk <command>` runs the `qvac-sdk` binary of the installed `@qvac/sdk-tools`
with the same arguments, in the same process, so output, exit codes and signal
handling are those of the SDK tools. The [SDK tools README](../sdk-tools/README.md)
documents every command and option. Tools and integrations that need only the SDK
commands can depend on `@qvac/sdk-tools` and run `qvac-sdk` directly.

## Earlier commands

`@qvac/cli` 0.18 and earlier ran the SDK commands at the top level. They still
run, with a warning on stderr that names the new form:

| Earlier           | Now                  |
| ----------------- | -------------------- |
| `qvac serve`      | `qvac sdk serve`     |
| `qvac bundle sdk` | `qvac sdk bundle`    |
| `qvac doctor`     | `qvac sdk doctor`    |
| `qvac configure`  | `qvac sdk configure` |
| `qvac verify`     | `qvac sdk verify`    |
| `qvac openai`     | `qvac sdk openai`    |

## Development

The commands and the packages they run are in [`src/route.ts`](src/route.ts).

```bash
pnpm install
cd packages/cli
npm run build
npm run test:unit
```

In the monorepo, pnpm links the workspace `@qvac/sdk-tools`; build it as well to
run `node dist/index.js sdk ...` locally. The SDK pod checks install this package
with npm and run `npm run sdk-source:workspace` first, which installs the sibling
`packages/sdk-tools`.
