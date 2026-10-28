# Browser example

Runs the SDK in a web page: load a GGUF model over HTTPS, chat with streaming
output, stop a generation, and inspect the engine's logs and stats. Requests run
in a Dedicated Worker on `@qvac/inference`, and the LLM addon runs as
WebAssembly on WebGPU. See the [browser guide](../../../../docs/website/content/_unpublished/sdk/browser.mdx).

From `packages/sdk`, after `npm run build` (and `npm run build:web` in
`packages/llm-llamacpp` when running from a source checkout):

```bash
npx vite@7 examples/browser            # development server
npx vite@7 build examples/browser      # production build into examples/browser/dist
npx vite@7 preview examples/browser
```

Open the printed URL in Chrome or Edge. `?model=<url>` selects another GGUF
model; its host must allow cross-origin requests.
