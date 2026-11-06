# Decision models prototype (QVAC-26667)

Tooling for the draft prototype of upstream llama.cpp decision models through
a QVAC-owned bridge in `@qvac/fabric`, `DecisionEngine` in
`@qvac/embed-llamacpp`, and `decide()` / `/v1/decisions`. Not for merge; the
go/no-go record lives in the stack's top pull request.

| File | Purpose |
| --- | --- |
| `check-resolution.sh` | Checks that the stack resolves to this checkout's workspace packages, not published copies. |
| `parity.mjs` | Compares the bridge with `llama-server` from the same fabric commit, per question type, against `tolerances.json`. |
| `requests.json` | The fixed `/v1/systemone` request set, including one rejected request. |
| `tolerances.json` | Declared tolerances. **Proposed until the decision owners agree them.** |
| `../../packages/embed-llamacpp/scripts/decision-parity-collect.js` | Runs the request set through `DecisionEngine` (Bare); `parity.mjs` starts it. |

## Reproduce from a clean checkout (macOS or Linux)

Prerequisites: Git, Node.js with Corepack, CMake, a C++ toolchain, and a Bare
runtime new enough for the repo's dependencies (`npx -y -p bare@latest bare`
works without a global install).

1. Check out the top of the stack and install. The lockfile carries this
   pull request's prototype-only overrides, which link
   `@qvac/embed-llamacpp` and embed's `@qvac/fabric` to the workspace:

   ```sh
   gh pr checkout <top-of-stack PR>
   corepack pnpm install --frozen-lockfile --ignore-scripts \
     --filter "@qvac/cli..." --filter "@qvac/embed-llamacpp..." --filter "@qvac/fabric"
   ```

2. Build, from the repo root. `@qvac/inference` is built with
   `--noEmitOnError false`: linked to workspace embed 0.55, its `model-fit`
   and rerank code no longer type-checks (embed's earlier breaking releases
   #5470 and #5398, not yet consumed by inference). That skew is unrelated to
   decisions and does not affect them at runtime.

   ```sh
   npm --prefix packages/fabric run build          # overlay (fabric PR #497), then link:platform
   npm --prefix packages/embed-llamacpp run build  # build:ts + build:native
   (cd packages/inference && npx tsc -p tsconfig.build.json --noEmitOnError false && npx tsc-alias -p tsconfig.alias.json)
   npm --prefix packages/sdk run build
   npm --prefix packages/cli run build
   ```

3. Check the resolution. Stop if it fails:

   ```sh
   bash scripts/decision-prototype/check-resolution.sh
   ```

4. Reference server, from fabric PR #497's commit, outside this checkout. The
   UI is not needed:

   ```sh
   git clone https://github.com/tetherto/qvac-fabric-llm.cpp && cd qvac-fabric-llm.cpp
   git checkout <F commit>
   cmake -B build -DLLAMA_BUILD_SERVER=ON -DLLAMA_MTMD=ON -DLLAMA_BUILD_TESTS=OFF \
     -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF
   cmake --build build --target llama-server
   ```

5. Models: llama-server's own test fixtures,
   [`ggml-org/tinylaya-for-testing-gguf`](https://huggingface.co/ggml-org/tinylaya-for-testing-gguf) and
   [`ggml-org/tinyopenjev-for-testing-gguf`](https://huggingface.co/ggml-org/tinyopenjev-for-testing-gguf)
   (with its mmproj). They are pinned in
   `packages/embed-llamacpp/test/integration/models.manifest.json`.

6. Run the SDK example, the CLI, and parity:

   ```sh
   (cd packages/sdk && npx tsx examples/decisions-upstream.ts /models/tinyopenjev-for-testing-Q8_0.gguf)
   node scripts/decision-prototype/parity.mjs --server <llama-server> \
     --model /models/tinyopenjev-for-testing-Q8_0.gguf \
     --mmproj /models/mmproj-tinyopenjev-for-testing-Q8_0.gguf --bare "npx -y -p bare@latest bare"
   ```

   `parity.mjs` uses the same model, context (`--ctx`, default 4096), slots
   (`--parallel`, default 2) and GPU offload (`--cpu` for CPU) on both sides,
   and exits 1 on any mismatch.
