# Changelog v0.4.0

Release Date: 2026-05-13

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.4.0

This release adds a new `qvac verify` command group for native-addon hygiene (lockfile diffs and bundle/ABI validation before things break on-device), wires image generation into the OpenAI-compatible HTTP server, and surfaces the new SDK `reasoning_budget` and Qwen3.5 / Gemma4 tool-call dialects through `qvac serve`.

---

## 🔌 New APIs

### `qvac verify deps` — catch native addon lockfile churn early

Worker bundles can silently inherit new native Bare addons through transitive lockfile changes, and the breakage only shows up later in the bundle step or on-device. `qvac verify deps` is a CI-friendly guardrail that compares two git refs' `package-lock.json` and reports added/removed native addons before packaging.

```bash
qvac verify deps --base upstream/main --head HEAD
qvac verify deps --base origin/main --head HEAD --quiet
qvac verify deps --base upstream/main --head HEAD \
  --lockfile packages/sdk/package-lock.json
```

Exit codes are designed for CI guardrails: `0` for no native changes (or no npm lockfile present at either ref), `1` for added/removed natives or a removed package whose native status could not be determined, and `2` for tool errors (missing args, unsupported lockfile, unresolvable git ref). Detection is npm-only — `package-lock.json` is the source of truth.

### `qvac verify bundle` — validate prebuilds and ABI before shipping

A companion to `verify deps`: where the former flags lockfile churn, `verify bundle` validates the actual artifact. Given a `worker.bundle.js` or a `node_modules` directory, and one or more target hosts, it checks that every native addon ships a `.bare` prebuild for each host and that each addon's `engines.bare` range is compatible with the resolved Bare runtime.

```bash
qvac verify bundle --addons-source qvac/worker.bundle.js \
  --host ios-arm64 \
  --host ios-arm64-simulator \
  --host ios-x64-simulator \
  --host android-arm64

qvac verify bundle --addons-source ./node_modules \
  --host darwin-arm64 \
  --host linux-x64 \
  --host win32-x64

qvac verify bundle --addons-source qvac/worker.bundle.js \
  --host ios-arm64 \
  --bare-runtime-version 1.26.0
```

The Bare runtime version is resolved in order: explicit `--bare-runtime-version` flag, then `bare-runtime/package.json`, then `bare/package.json`. Mobile and Expo CI should pass `--bare-runtime-version` explicitly — `react-native-bare-kit` does not expose embedded runtime metadata.

Pinning the runtime version also works via a `qvac.config.{json,js,mjs,ts}` file auto-detected from the current directory (or pointed at with `--config <path>`):

```json
// qvac.config.json
{ "bareRuntimeVersion": "1.26.0" }
```

```bash
qvac verify bundle --addons-source qvac/worker.bundle.js --host ios-arm64
```

Issue codes:

- **Errors** (exit `1`): `missing-prebuild`, `abi-mismatch`, `invalid-runtime-version`, `invalid-source`.
- **Warnings** (exit `0`): `unknown-runtime-version`, `malformed-engines-bare`.

### `POST /v1/images/generations` on `qvac serve openai`

The OpenAI-compatible HTTP server now exposes image generation, backed by the SDK `diffusion()` primitive. The startup banner lists `POST /v1/images/generations` whenever an `image`-category model is configured. The route is a stateless adapter — request → SDK → response, no storage, no re-encoding.

Configure a diffusion model (and, optionally, alias common OpenAI model names like `gpt-image-2` to it for drop-in client compatibility):

```json
// qvac.config.json
{
  "serve": {
    "models": {
      "sd21": {
        "model": "SD_V2_1_1B_Q4_0",
        "default": true,
        "preload": true,
        "config": { "prediction": "v" }
      }
    }
  }
}
```

Blocking JSON response (default):

```json
{
  "created": 1718000000,
  "output_format": "png",
  "size": "1024x1024",
  "data": [
    { "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." }
  ]
}
```

Streaming (`stream: true`) returns a single `image_generation.completed` SSE event followed by `[DONE]`, matching OpenAI's documented `partial_images: 0` behaviour:

```
event: image_generation.completed
data: {"type":"image_generation.completed","created_at":1718000000,"output_format":"png","size":"1024x1024","b64_json":"iVBORw0KGgoAAAANSUhEUgAA..."}

data: [DONE]
```

Behaviour notes:

- `size = "WxH"` (multiples of 8) or `"auto"`; absent → SDK defaults.
- `n` is a positive integer, forwarded as-is to SDK `batch_count` (no upper clamp). `n < 1`, non-integer, or non-number → `400 invalid_n`.
- `response_format` defaults to `b64_json`; `"url"` returns `data:image/png;base64,...`. Ignored when `stream: true`.
- `output_format=jpeg|webp` is accepted but the body is still PNG; the response echoes `output_format: "png"` so clients can detect the mismatch and decide whether to fall back. Honoring other encodings server-side will likely require an encoder dependency (e.g. `sharp`) and is tracked separately.
- `quality`, `style`, `background`, `moderation`, `output_compression`, `partial_images`, and `user` are accepted and warned.

### Qwen3.5 / Gemma4 tool-call dialects and `reasoning_budget` through `qvac serve`

The SDK now parses Qwen3.5 / Qwen3.6 (Pythonic-XML: `<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>`) and Gemma4 (`<|tool_call>call:NAME{...}<tool_call|>`) tool-call output formats, with auto-detection from the model name/path. The CLI exposes this transparently through the OpenAI chat-completions surface and adds `reasoning_budget` to the request body as a boolean (`true` → `-1` unrestricted, `false` → `0` disabled):

```json
POST /v1/chat/completions
{
  "model": "qwen35",
  "messages": [{ "role": "user", "content": "Think step by step." }],
  "reasoning_budget": false
}
```

Requires `@qvac/sdk@^0.10.0`. Tool-call examples for both dialects live under the SDK's `examples/tools/`.

---

## 🧹 Maintenance

The repo-wide PR template consolidation deleted the stale `packages/cli/PULL_REQUEST_TEMPLATE.md` (along with 18 other unused per-package copies). GitHub only ever auto-discovered the two canonical templates at `.github/PULL_REQUEST_TEMPLATE/{sdk-pod,addon}.md`, and the CLI's per-package template was invisible to the GitHub UI; only ad-hoc tooling that read it was ever affected, and that tooling now points at the canonical addon template. No behaviour change for end users of `@qvac/cli`.
