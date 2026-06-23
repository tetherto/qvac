# Agent Integrations

This document is the monorepo reference for QVAC's coding-agent integration stack: `@qvac/ai-sdk-provider`, `@qvac/opencode-plugin`, `qvac serve openai`, QVAC docs, and the external `models.dev` provider metadata.

Use it when implementing, reviewing, or releasing work related to OpenCode, OpenClaw, Cline/Roo/Aider/Continue, Vercel AI SDK consumers, managed `qvac serve`, OpenAI-compatible HTTP behavior, model discovery, or package release choreography.

## Why this stack exists

QVAC's core SDK is a local-first runtime. It loads native inference addons through a Bare-backed worker, downloads model files through the registry/P2P stack, identifies models with generated constants, and applies many model options at load time.

Coding-agent ecosystems expect a different shape:

- an OpenAI-compatible HTTP API,
- Vercel AI SDK provider metadata,
- `models.dev` discovery,
- simple model strings in tool configuration,
- and a low-friction startup path that does not require a second terminal.

The integration stack bridges those two worlds without putting agent-specific assumptions into SDK core:

```text
OpenCode / coding agent
  -> @qvac/opencode-plugin                 (OpenCode-specific turnkey UX)
    -> @qvac/ai-sdk-provider managed mode  (spawn/reuse local qvac serve)
      -> @qvac/cli qvac serve openai       (OpenAI-compatible HTTP adapter)
        -> @qvac/sdk                       (client RPC, Bare worker, native addons)
          -> registry + model constants    (P2P model metadata/files)
```

Manual/custom-provider integrations skip the OpenCode plugin:

```text
OpenCode / Cline / Aider / Continue / Roo / Open WebUI
  -> custom OpenAI-compatible provider config
    -> qvac serve openai
      -> @qvac/sdk
```

The design rule is: keep general OpenAI-compatible behavior in `@qvac/cli`, generic AI SDK behavior in `@qvac/ai-sdk-provider`, and tool-specific convenience in `plugins/opencode`.

## Package map

| Package / area | Path | Public package | Primary role |
| --- | --- | --- | --- |
| SDK | `packages/sdk` | `@qvac/sdk` | Canonical QVAC API: model loading, completion, tool-call parsing, registry integration, cancellation primitives, native addon RPC. |
| CLI OpenAI server | `packages/cli/src/serve` | `@qvac/cli` | Runs `qvac serve openai`, exposes OpenAI-compatible HTTP routes, owns request/response translation, model alias routing, auth/CORS, cancellation, queueing, and lifecycle for loaded models. |
| AI SDK provider | `packages/ai-sdk-provider` | `@qvac/ai-sdk-provider` | Vercel AI SDK provider wrapper. Owns `createQvac`, external/managed modes, typed model metadata exports, friendly catalog ids, and managed serve reuse/lifecycle. |
| OpenCode plugin | `plugins/opencode` | `@qvac/opencode-plugin` | OpenCode-specific turnkey setup. Starts a host process, injects a `qvac` provider into OpenCode config, selects project model defaults, applies temporary OpenAI-compat shims, and tears down on exit. |
| Public HTTP docs | `docs/website/content/docs/cli/http-server` | QVAC docs | Public setup docs for OpenAI-compatible tools. OpenCode docs should be plugin-first; manual server setup is the advanced/custom-provider path. |
| Architecture docs | `docs/architecture` | Internal repo docs | Design/reference material for maintainers and agents. |
| External provider catalog | `providers/qvac` in `anomalyco/models.dev` | `models.dev` entry | External discovery metadata for QVAC provider/models. Not a runtime source of truth. |

## Dependency chain

`@qvac/opencode-plugin` depends on:

- `@opencode-ai/plugin` for OpenCode plugin hooks/types.
- `@qvac/ai-sdk-provider` for managed mode and model catalog resolution.
- `@qvac/cli` so managed mode can run `qvac serve`.
- `@ai-sdk/openai-compatible` and `ai`, because OpenCode consumes Vercel AI SDK providers.

`@qvac/ai-sdk-provider` depends on:

- `@ai-sdk/openai-compatible` for provider creation.
- `ai` as the Vercel AI SDK peer surface.
- `@qvac/cli` as the optional managed-mode dependency.
- Generated model metadata from the QVAC SDK/registry.

`@qvac/cli` depends on:

- `@qvac/sdk` for inference, model loading, cancellation, and registry metadata.
- Native addon packages transitively through SDK/runtime configuration.

The plugin only works as well as the full dependency chain:

```text
opencode-plugin -> ai-sdk-provider -> cli -> sdk -> native addons / registry
```

When a bug is fixed in a lower layer, check whether upper package dependency ranges float to it. If every range is caret-compatible, a fresh plugin install may already resolve the fixed transitive version. If a feature requires new upper-layer code or a dependency range bump, release the affected packages in dependency order.

## Layer ownership

### `@qvac/sdk`

Implement here when the change is about QVAC's core inference semantics:

- model loading/unloading,
- registry-backed model sources and cache paths,
- completion event shapes,
- tool-call parsing and dialect detection (`hermes`, `pythonic`, `json`, `harmony`, `qwen35`, `gemma4`),
- cancellation primitives and request lifecycle invariants,
- structured error types/codes,
- RPC client/server contracts,
- generated model constants and registry metadata.

Do not implement OpenCode-specific request-shape hacks here unless the behavior is actually required by the OpenAI-compatible API generally. The SDK should not know about OpenCode, Cline, Aider, or any other agent.

### `@qvac/cli` / `qvac serve openai`

Implement here when the behavior belongs to the OpenAI-compatible HTTP API:

- HTTP routes: `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/embeddings`, `/v1/audio/*`, `/v1/images/*`, `/v1/videos`.
- OpenAI request validation and response envelopes.
- OpenAI parameter mapping (`temperature`, `max_tokens`, `response_format`, tool schemas, etc.).
- Server-side model alias routing from `serve.models`.
- Per-route client-disconnect cancellation bridge.
- Same-model request queueing and route-level concurrency behavior.
- CORS, bearer auth, docs/spec flags.
- Generic compatibility fixes for OpenAI-shaped clients.

If a shim in `@qvac/opencode-plugin` becomes generally true for all OpenAI-compatible clients, move it down into CLI serve and remove it from the plugin.

### `@qvac/ai-sdk-provider`

Implement here when the behavior is generic to Vercel AI SDK consumers:

- `createQvac` external-mode defaults and provider branding.
- Managed mode: synthesize temporary serve config, spawn/reuse `qvac serve`, expose `baseURL`, `port`, `pid`, and `close()`.
- Shared serve fleet key, idle reaping, crash recovery, and registry cleanup under `~/.qvac/managed-serves/`.
- Typed model metadata exports (`models`, `allModels`, `ModelConstant`, `EndpointCategory`).
- Friendly catalog ids (`qvacCatalog`) and mapping from public ids to SDK constants.
- AI SDK provider ergonomics that would help any AI SDK script, not just OpenCode.

Do not add OpenCode config injection, OpenCode project defaults, or OpenCode-specific stderr/TUI behavior here.

### `@qvac/opencode-plugin`

Implement here only for OpenCode-specific behavior:

- OpenCode plugin hook integration.
- Injecting `provider.qvac` into OpenCode's config.
- Setting project `model` and `small_model` to `qvac/<model>` when `setDefaultModel` is true.
- Spawning a real Node/Bun host process because OpenCode runs plugins inside a compiled binary whose `process.execPath` is not a JS runtime.
- Returning quickly on `QVAC_LISTENING` so `opencode run` does not hit startup timeout while model download/preload continues behind the local proxy.
- Proxy/shim behavior that only exists because OpenCode or `@ai-sdk/openai-compatible` currently disagrees with QVAC serve.
- Plugin option parsing from defaults, project `qvac.json`, plugin tuple options, and `QVAC_*` env vars.

Plugin code should stay small. If a feature is useful outside OpenCode, move it down to `@qvac/ai-sdk-provider` or `@qvac/cli`.

### `models.dev`

Implement here when the behavior is external catalog metadata:

- `providers/qvac/provider.toml`,
- model TOMLs under `providers/qvac/models`,
- capability flags (`tool_call`, `reasoning`, modalities, limits, cost),
- provider `doc` link to QVAC setup docs.

Do not encode QVAC runtime behavior in models.dev. It is discovery metadata, not the source of truth for managed mode or model loading.

### Public docs

For OpenCode docs, lead with `@qvac/opencode-plugin`. Manual `qvac serve openai` and custom provider JSON are advanced paths.

Docs should answer:

- what to install,
- which model to choose,
- what hardware/performance trade-off to expect,
- what the plugin manages,
- when manual `qvac serve openai` is needed,
- which features are temporary shims or known limitations.

Avoid framing docs around internal state users should not need to think about, such as "no provider block", "no second terminal", or "no `QVAC_MODEL` prefix". State the positive behavior instead: the plugin starts managed QVAC serve, registers `qvac`, and selects a project model.

## Managed mode design decisions

Managed mode exists because coding-agent users should not have to run a second terminal or author `qvac.config.json` for the normal case.

Key decisions:

- `createQvac({ mode: "managed" })` is async because it must spawn or attach to a server and wait until it is healthy.
- It synthesizes a serve config from model specs instead of requiring a file on disk.
- It starts `qvac serve` on an auto-allocated loopback port unless a port is pinned.
- It reuses an existing compatible serve by deriving a fleet key from model set, per-model config, host, binary path, and related serve options.
- It tracks liveness by consumer processes, not HTTP traffic. A tool that only receives `baseURL` does not keep the serve alive unless the process that called `createQvac` stays alive.
- `close()` / `AsyncDisposable` detach the current consumer; they do not necessarily kill a shared serve.
- It keeps shared serve records under `~/.qvac/managed-serves/` and sweeps dead records to avoid orphaned state.
- It only retries connection-refused requests. It must not blindly replay completions that may already have begun.

## OpenCode plugin design decisions

OpenCode-specific constraints shaped the plugin:

- OpenCode plugins run inside OpenCode's compiled binary. `process.execPath` points at the editor/binary, not Node/Bun, so `@qvac/ai-sdk-provider` cannot spawn its managed supervisor directly from the plugin process.
- The plugin therefore spawns a host child in a real Node/Bun runtime. The host imports `@qvac/ai-sdk-provider`, starts managed mode, and owns the local proxy.
- The host prints `QVAC_LISTENING` as soon as the local proxy is listening, before model download/preload completes. The plugin can then inject the provider and return within OpenCode's startup budget.
- The first user turn may be slow on a cold model because the proxy waits for the upstream serve/model to become ready.
- Host logs are quiet by default so they do not corrupt OpenCode's TUI. `debug` / `QVAC_DEBUG=1` mirrors milestones and request traces to stderr.
- Multiple OpenCode windows share a matching serve through provider managed-mode reuse.

Current plugin shims:

- **Array `content` flattening**: `@ai-sdk/openai-compatible` sends OpenAI array-of-parts message content. QVAC serve currently accepts text content, so the plugin proxy flattens text parts and drops non-text parts. Move this down when serve supports the needed shape directly.
- **Reasoning stream transform**: reasoning models may emit `<think>...</think>` inside content. The proxy transforms this to `reasoning_content` so OpenCode renders a collapsed thought block instead of raw tags. Move this down when serve emits a first-class reasoning channel for OpenAI-compatible streaming.

These shims are stopgaps. Track them as debt; do not duplicate them in other plugins unless the same client mismatch exists.

## Model selection and catalogs

There are three model naming layers:

| Layer | Example | Owner | Notes |
| --- | --- | --- | --- |
| Friendly catalog id | `qwen3.5-9b` | `@qvac/ai-sdk-provider` `qvacCatalog`, mirrored to models.dev | Easy for users and OpenCode model picker. Maps to a default SDK constant/quantization. |
| SDK model constant | `GPT_OSS_20B_INST_Q4_K_M` | `@qvac/sdk` generated constants | Precise model source and quantization. Raw constants pass through managed mode. |
| Serve alias | `qwen3.5-9b` or `GPT_OSS_20B_INST_Q4_K_M` | CLI serve config / managed synth config | The HTTP `model` field clients use. |

`@qvac/opencode-plugin` accepts both friendly ids and raw QVAC constants:

- Friendly ids are resolved through `@qvac/ai-sdk-provider/models` `findCatalogEntry()`.
- Raw constants are passed through and become the serve alias/model id shown in OpenCode.

Document both. Do not imply only friendly ids are supported. Friendly ids are better for common defaults; raw constants are how users reach SDK chat models before they have friendly aliases.

Current plugin-friendly defaults:

- `qwen3.5-9b` — default friendly id; best friendly-id default.
- `qwen3.5-4b` — smaller/faster fallback.
- `qwen3.5-2b`, `qwen3.5-0.8b` — smoke tests/low-memory use, not ideal for real agent work.

Important raw constants to mention when relevant:

- `GPT_OSS_20B_INST_Q4_K_M` — larger local text/code model for demanding agent work.
- `GEMMA4_31B_MULTIMODAL_Q4_K_M` — larger Gemma4 model; requires enough memory.

When adding a new friendly id:

1. Confirm the SDK constant exists in generated model constants.
2. Add a `qvacCatalog` entry in `packages/ai-sdk-provider/src/models/catalog.ts`.
3. Add/update catalog tests for id uniqueness and constant existence.
4. Add matching models.dev TOML if it is meant for external catalog discovery.
5. Update plugin README/docs model-selection guidance if it changes recommendations.

## Implementing a new feature

Use this decision tree before coding:

1. Is it a core model/inference behavior? Put it in `@qvac/sdk`.
2. Is it an OpenAI HTTP request/response compatibility behavior? Put it in `@qvac/cli` serve.
3. Is it AI SDK provider lifecycle, managed mode, model metadata, or generic AI SDK ergonomics? Put it in `@qvac/ai-sdk-provider`.
4. Is it OpenCode config injection, plugin option parsing, startup/TUI behavior, or OpenCode-only workaround? Put it in `@qvac/opencode-plugin`.
5. Is it catalog metadata for discovery? Put it in models.dev.
6. Is it user-facing explanation or setup? Update QVAC docs and package READMEs.

Common examples:

| Request | Layer |
| --- | --- |
| Add support for a new OpenAI request field like `response_format` | CLI serve, then provider/docs if exposed to AI SDK users |
| Fix Qwen/Gemma/GPT-OSS tool-call parsing | SDK |
| Add a new friendly `qwen3.6-35b-a3b` model id | AI SDK provider catalog + models.dev + docs |
| Make OpenCode start faster or avoid TUI log noise | OpenCode plugin |
| Make all OpenAI clients accept array-of-parts message content | CLI serve |
| Change managed serve reuse/idle timeout behavior | AI SDK provider |
| Add a new external catalog model | models.dev, and maybe provider catalog if we want friendly id resolution |

## Testing expectations

### SDK

- Unit tests for parsers, schemas, error surfaces, lifecycle primitives.
- E2E tests for public SDK API changes.
- Verify Bare compatibility when touching runtime/process behavior.

### CLI serve

- Route/unit tests for validation, translation, error envelopes, streaming, cancellation, and model routing.
- Node-based e2e tests for `qvac serve openai` when changing public HTTP behavior.
- Update OpenAPI/docs if route behavior changes.

### AI SDK provider

- Unit tests for catalog resolution, managed config synthesis, errors, lifecycle/reuse, and model metadata exports.
- Integration smoke tests when changing managed mode or `createQvac` behavior.
- Verify dependency ranges against `@qvac/cli` and `@qvac/sdk` before publishing.

### OpenCode plugin

- Unit tests for option precedence, host config, provider injection, proxy transforms, and error handling.
- E2E/smoke test against a real `opencode` run when changing startup, host process, proxy, or default model behavior.
- Keep examples and README in sync with options.

### models.dev

- Run `bun run validate`.
- Ensure provider `doc` points to the best user setup page, not a low-level API reference.

## Release workflow

Release lower layers before upper layers when a feature spans packages:

1. `@qvac/sdk` — model constants, inference semantics, parser fixes.
2. `@qvac/cli` — server routes or serve behavior that depends on SDK changes.
3. `@qvac/ai-sdk-provider` — managed mode/provider changes that depend on CLI behavior.
4. `@qvac/opencode-plugin` — plugin changes that depend on provider/CLI.
5. Docs/models.dev can land alongside the package that makes the behavior real, but avoid documenting unreleased package behavior as current.

If upper packages use caret ranges that already resolve to a lower-layer patch fix, a new upper release may not be needed. Verify with a fresh install, not just lockfile assumptions.

### QVAC package releases

Follow the repo's release branch workflow:

- Create upstream `release-<package>-<version>` branch from `main`.
- Create a release branch on the fork with version bump and changelog.
- Open fork -> upstream release branch PR.
- Merge release PR to publish GitHub Package Registry.
- Backmerge release artifacts to `main` to publish npm.

For normal docs/code PRs in `tetherto/qvac`:

- Branch from a fork.
- Use the repo's PR title/body format.
- Add required labels.
- Use SDK pod template headings for SDK pod/package changes.

### npm README updates

Package README changes only reach npm when the package is republished. If the docs fix is important for npmjs.com, plan a patch release of the package even if no runtime code changed.

### models.dev PRs

models.dev uses `dev` as its base branch. Validate with:

```bash
cd ../models.dev
bun run validate
```

When QVAC docs links change, update `providers/qvac/provider.toml` in models.dev and the PR body so reviewers understand the setup path.

## PR and docs checklist

Before opening or updating PRs for this stack:

- [ ] Is the change in the lowest correct layer?
- [ ] Are plugin-specific workarounds kept out of SDK/CLI/provider core?
- [ ] Do public docs lead OpenCode users to `@qvac/opencode-plugin` first?
- [ ] Do docs distinguish friendly ids from raw QVAC constants?
- [ ] Are dependency ranges sufficient for the intended transitive fixes?
- [ ] If npm README behavior changes, is a package release planned?
- [ ] Are models.dev TOMLs and `qvacCatalog` consistent when adding friendly ids?
- [ ] Were relevant tests run (`bun run validate` for models.dev, package tests for QVAC)?

## Related references

- `packages/cli/docs/serve-openai.md` — `qvac serve openai` route/config reference.
- `docs/architecture/ARCHITECTURE.md` — SDK architecture.
- `.cursor/rules/agent-integrations.mdc` — Cursor-local quick reference for this stack.
- `.cursor/rules/sdk/main.mdc` — SDK coding conventions.
- `packages/ai-sdk-provider/README.md` — public provider docs.
- `plugins/opencode/README.md` — public plugin docs.
- `docs/website/content/docs/cli/http-server/connection.mdx` — public tool/OpenCode setup docs.
