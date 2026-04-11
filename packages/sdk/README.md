# QVAC SDK

**QVAC SDK** is the canonical entry point to develop AI applications with QVAC.

> _Part of **QVAC** ecosystem_
> <br>
> <sup>
> <a href="https://qvac.tether.dev" >Home</a> &nbsp;•&nbsp;
> <a href="https://qvac.tether.dev/docs" >Docs</a> &nbsp;•&nbsp;
> <a href="https://discord.com/channels/1425125849346216029/1445400675189264516" >Support</a> &nbsp;•&nbsp;
> <a href="https://discord.com/invite/tetherdev" >Discord</a>

**QVAC SDK** is the main entry point for developing applications with QVAC. It is type-safe and exposes all QVAC capabilities through a unified interface. It runs on Node.js, [Bare runtime](https://bare.pears.com), and [Expo](https://expo.dev).

See [https://docs.qvac.tether.io/sdk/getting-started](https://docs.qvac.tether.io/sdk/getting-started) for the comprehensive QVAC documentation.

## Supported environments and installation

See https://docs.qvac.tether.io/sdk/getting-started/installation

## Quickstart

1. Create the examples workspace:

```bash
mkdir qvac-examples
cd qvac-examples
npm init -y && npm pkg set type=module
```

2. Install the SDK:

```bash
npm install @qvac/sdk
```

3. Create the quickstart script:

```js
import { loadModel, LLAMA_3_2_1B_INST_Q4_0, completion, unloadModel, } from "@qvac/sdk";
try {
    // Load a model into memory
    const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        onProgress: (progress) => {
            console.log(progress);
        },
    });
    // You can use the loaded model multiple times
    const history = [
        {
            role: "user",
            content: "Explain quantum computing in one sentence",
        },
    ];
    const result = completion({ modelId, history, stream: true });
    for await (const token of result.tokenStream) {
        process.stdout.write(token);
    }
    // Unload model to free up system resources
    await unloadModel({ modelId });
}
catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
}
```

4. Run the quickstart script:

```bash
node quickstart.js
```

## Examples

In the `./examples` subdirectory, you will find scripts demonstrating how to use all SDK functionalities. To try any of them:

1. Build the SDK from source (see [Build](#build) section).
2. Run using Bare, Node.js, or Bun as the runtime:

```bash
# With Bare
bun run bare:example dist/examples/path/to/example.js

# With Node
node dist/examples/path/to/example.js

# With bun, straight from source
bun run examples/path/to/example.ts
```

## Build

Use the [Bun](https://bun.sh/) package manager:

```bash
bun i
```

```bash
bun run build  # or `watch` for hotreload
```

```bash
bun run build:pack
```

This outputs a tarball under `dist/sdk-{version}.tgz` that you can install in your project, e.g.:

```bash
npm i path/to/sdk-0.3.0.tgz
```

## Contributing

### Commit Message and PR Title Format

This repository enforces structured commit messages and PR titles to maintain consistency and generate changelogs automatically.

#### Format

**Commit messages:**

```
prefix[tags]?: subject
```

**PR titles:**

```
TICKET prefix[tags]: subject
```

#### Allowed Prefixes

- `feat` - New features or capabilities
- `fix` - Bug fixes
- `doc` - Documentation changes
- `test` - Test additions or modifications
- `mod` - Model-related changes
- `chore` - Maintenance tasks
- `infra` - CI/CD, tooling, infrastructure

#### Allowed Tags

Tags are optional:

- `[api]` - API changes (non-breaking)
- `[bc]` - Breaking changes (including breaking API changes)

#### Examples

**Valid commit messages:**

```bash
feat: add RAG support for LanceDB
fix[api]: fix completion stream error handling
doc: update installation instructions
feat[bc]: redesign loadModel signature
chore: update dependencies
```

**Valid PR titles:**

```bash
QVAC-123 feat: add RAG support for LanceDB
QVAC-456 fix[api]: fix completion stream error handling
QVAC-789 doc: update installation instructions
QVAC-101 feat[bc]: redesign loadModel signature
```

#### Code Examples Requirements

When creating PRs with specific tags, you must include code examples in the PR description:

**`[bc]` tag requirements:**

Must include BEFORE/AFTER code examples showing the migration path:

````markdown
## BC Changes

**BEFORE:**

```typescript
const model = await loadModel("model-path");
```

**AFTER:**

```typescript
const modelId = await loadModel("model-path", { modelType: "llm" });
```
````

Or using inline comments:

````markdown
```typescript
// old
const model = await loadModel("model-path");

// new
const modelId = await loadModel("model-path", { modelType: "llm" });
```
````

**`[api]` tag requirements (non-breaking):**

Must include at least one fenced code block showing the new API usage:

````markdown
## New API

```typescript
// New completion API with streaming support
for await (const token of completion({
  modelId,
  history: [{ role: "user", content: "Hello!" }],
}).tokenStream) {
  process.stdout.write(token);
}
```
````

#### Validation

- **Commit messages** are validated automatically via Husky commit-msg hook
- **PR titles and descriptions** are validated via GitHub Actions on PR creation/update
- Invalid commits or PRs will be rejected with helpful error messages
- **Auto-skipped commits:** The following Git-generated commits bypass validation:
  - Merge commits (e.g., `Merge pull request #123`)
  - Version bumps (e.g., `1.0.0`, `v1.0.0`)
  - Revert commits (e.g., `Revert "feat: add feature"`)
  - Squash commits (e.g., `squash! fix: bug fix`)

#### Generating Changelogs

Once your PRs are merged into `dev`, you can generate a changelog:

```bash
npm run changelog:generate
```

This will:

1. Compare versions between `dev` and `main` branches
2. Collect all merged PRs
3. Parse and classify each PR by prefix
4. Generate `changelog/<version>/CHANGELOG.md`
5. Generate `changelog/<version>/breaking.md` for BC changes (with code examples)
6. Generate `changelog/<version>/api.md` for API changes (with code examples)

**Note:** Requires a GitHub token (`GITHUB_TOKEN` or `GH_TOKEN` environment variable) to fetch PR metadata.