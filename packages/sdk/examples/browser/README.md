# Browser WebGPU PoC

This page loads a GGUF model and runs it locally through the public `@qvac/sdk` API, a Dedicated Worker, the inference engine, the browser build of `@qvac/llm-llamacpp`, and WebGPU.

Install and activate the Emscripten version pinned in
[`@qvac/llm-llamacpp`'s browser guide](../../../llm-llamacpp/docs/browser.md), then run from a clean checkout of the complete PR stack:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @qvac/llm-llamacpp build:web
corepack pnpm --filter @qvac/inference build
corepack pnpm --filter @qvac/sdk build
corepack pnpm dlx vite@7.3.8 packages/sdk/examples/browser --host 127.0.0.1
```

Open the printed local URL in a current browser with WebGPU and `shader-f16`, then click **Load model** and **Run completion**. The default Qwen3.5 2B Q4 model downloads about 1.4 GB on the first run and is reused from browser storage afterwards. To use local files, select one GGUF or all files in a sharded GGUF group before loading.

Applications can also mount files selected by the user. Mount related files together so GGUF shards remain siblings:

```js
import { mountBrowserFiles, loadModel } from '@qvac/sdk'

const files = Array.from(document.querySelector('#model-files').files).sort((left, right) =>
  left.name.localeCompare(right.name)
)
const paths = await mountBrowserFiles(files)
const modelId = await loadModel({ modelSrc: paths[0] })
```

No unsafe browser flags are required. If Chrome on Linux does not expose a compatible adapter,
the page shows the tested Vulkan-setting instructions.
