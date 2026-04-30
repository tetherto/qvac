# Running the LIBERO closed-loop sim for SmolVLA

This describes how to run the LIBERO closed-loop eval against either
the **QVAC GGUF policy** (via the `@qvac/vla` addon over HTTP) or the
**original PyTorch SmolVLA policy**, so the two are directly
comparable on the same seeds and tasks.

The driver is `packages/vla/sim/eval_libero_sim.py`. It re-uses
lerobot's eval pipeline; the only difference is that for the QVAC
backend we monkey-patch `make_policy` to wrap the PyTorch policy with
an HTTP shim (`SmolVLAQvacHTTPPolicy`) that delegates inference to the
running `vla-server`.

---

## 0. Install

Tested on Ubuntu 22.04 with an NVIDIA GPU. **Python 3.12 is required**
— lerobot 0.5.2 uses PEP 695 generic syntax that older interpreters
won't parse.

```bash
# 1) System deps for headless MuJoCo rendering (Ubuntu/Debian):
sudo apt install -y libegl1 libgl1 libglu1-mesa libosmesa6 libglew-dev \
    libxrandr-dev libxinerama-dev libxcursor-dev libxi-dev ffmpeg

# 2) Create the venv:
python3.12 -m venv vla-env
source vla-env/bin/activate
pip install --upgrade pip wheel

# 3) torch first — pin to the CUDA build matching your driver. Our
#    server uses CUDA 12.8:
pip install torch==2.10.0 torchvision==0.25.0 \
    --index-url https://download.pytorch.org/whl/cu128

# 4) Pip-installable deps:
pip install -r packages/vla/sim/requirements.txt

# 5) Headless MuJoCo backend (export this in every shell that runs the eval):
export MUJOCO_GL=egl
```

LIBERO BDDL task files and 3D assets auto-download into
`~/.cache/libero/assets` on first run, so no manual asset step is
needed.

CPU-only fallback works (replace step 3 with the `cpu` index URL) but
PyTorch-mode eval is then ~5× slower. QVAC mode does not need PyTorch
on the GPU — it only needs the addon's Vulkan path.

---

## 1. What's in this folder

Every file is needed for the qvac backend. PyTorch backend only needs
`eval_libero_sim.py`.

| File | Role | Used in mode |
|---|---|---|
| `eval_libero_sim.py` | Python entry point. Parses `--backend`, then calls lerobot's `eval_main`. In qvac mode it monkey-patches `lerobot.policies.make_policy` to wrap the PyTorch policy with `SmolVLAQvacHTTPPolicy`. | both |
| `qvac_http_policy.py` | Subclass of lerobot's `SmolVLAPolicy`. Inherits *all* preprocessing / state normalization / action queueing / unnormalization — only the network forward pass is replaced. Calls `SmolVLAHTTP.predict_raw()` instead of running the PyTorch transformer. | qvac |
| `smolvla_http.py` | Tiny binary-protocol HTTP client. Tokenizes the instruction with the SmolVLM2 tokenizer, packs `{state, images, tokens, mask, noise}` into a single POST body, parses the response. | qvac |
| `server/server.js` | Bare HTTP server hosting the `@qvac/vla` addon. Loads the GGUF once at boot, exposes `/info` + `/predict` on `127.0.0.1:8765`. | qvac |
| `server/package.json` | Declares the server's three runtime deps: `@qvac/vla`, `bare-http1`, `bare-process`. | qvac |
| `requirements.txt` | Pinned Python deps for the eval driver + lerobot policy code. | both |
| `README.md` | This file. | — |

**lerobot itself is not patched.** The bridge works through lerobot's
public `make_policy` extension point + Python class-swap (`policy.__class__
= SmolVLAQvacHTTPPolicy`), so the same lerobot release that scores
PyTorch SmolVLA also scores the GGUF.

### Call chain (qvac mode)

```
eval_libero_sim.py                  (Python entry, parses --backend)
    └─► lerobot.scripts.lerobot_eval.eval_main()
            └─► make_policy()       ← monkey-patched
                    └─► SmolVLAQvacHTTPPolicy.from_pytorch(pytorch_policy)
                            └─► SmolVLAHTTP(host=127.0.0.1, port=8765)
                                    └─► POST /predict     (binary body)
                                            ↓
                                    server/server.js
                                        └─► @qvac/vla → ggml on Vulkan
                                            └─► returns 50×7 action chunk
```

---

## 2. Backends at a glance

| Backend | Inference path | Needs server? | Device |
|---|---|---|---|
| `--backend qvac` | lerobot → HTTP → `@qvac/vla` addon → ggml on Vulkan | **Yes** (`vla-server` on `:8765`) | GPU (Vulkan) — pass `--policy.device=cpu` since the PyTorch policy is only kept around for preprocessing in qvac mode |
| `--backend pytorch` | lerobot → PyTorch SmolVLAPolicy → CUDA | No | `--policy.device=cuda` |

**The qvac backend evaluates whatever GGUF the server was started
with.** The script does not pin a model file — the GGUF identity lives
in the `QVAC_VLA_MODEL` env var passed to the server at startup. To
compare F32 GGUF vs Q8 GGUF, restart the server with a different
`QVAC_VLA_MODEL` between runs.

---

## 3. Starting the vla-server (qvac mode only)

One-time setup of the server's Node deps:

```bash
cd packages/vla/sim/server
npm install
```

This pulls `@qvac/vla` from npm (the prebuilds wheel) along with
`bare-http1` / `bare-process`. Make sure you have `bare` installed
globally (`npm install -g bare bare-make`).

Start the server, pointing at the GGUF you want to score (path is
**required** — there is no default):

```bash
# kill any previous instance
pkill -f 'server.js' || true

# start with a specific GGUF:
QVAC_VLA_MODEL=/abs/path/to/smolvla-libero-vision-q8.gguf \
    nohup setsid bare packages/vla/sim/server/server.js \
    > /tmp/vla-server.log 2>&1 < /dev/null & disown

# wait until weights are loaded (~10 s on Vulkan, longer on CPU):
until curl -s --max-time 2 http://127.0.0.1:8765/info | grep -q chunkSize; do
  sleep 2
done
echo "server ready"
```

The GGUF has to match the SmolVLA architecture (same hparams as
`HuggingFaceVLA/smolvla_libero`). The currently-tested file is
`smolvla-libero-vision-q8.gguf`; produce it from a converter that
emits a SmolVLA-compatible GGUF (Q8_0 on the vision-encoder linear
weights, F32 on biases / norms / pos embeds / patch-embed conv2d), or
ask a maintainer for a pre-built copy.

---

## 4. Running the eval

### One task, quick smoke (~20 s wall):
```bash
python packages/vla/sim/eval_libero_sim.py \
  --backend qvac \
  --policy.path=HuggingFaceVLA/smolvla_libero \
  --env.type=libero --env.task=libero_spatial \
  --env.task_ids='[0]' \
  --eval.n_episodes=1 --eval.batch_size=1 \
  --policy.device=cpu \
  --output_dir=/tmp/smoke_qvac
```

### Full libero_spatial eval (10 tasks × 3 episodes = 30, ~17 min wall):
```bash
# QVAC (whatever GGUF the server loaded):
python packages/vla/sim/eval_libero_sim.py \
  --backend qvac \
  --policy.path=HuggingFaceVLA/smolvla_libero \
  --env.type=libero --env.task=libero_spatial \
  --eval.n_episodes=3 --eval.batch_size=1 \
  --policy.device=cpu \
  --output_dir=./eval_qvac_$(date +%F)

# PyTorch reference (no server needed):
python packages/vla/sim/eval_libero_sim.py \
  --backend pytorch \
  --policy.path=HuggingFaceVLA/smolvla_libero \
  --env.type=libero --env.task=libero_spatial \
  --eval.n_episodes=3 --eval.batch_size=1 \
  --policy.device=cuda \
  --output_dir=./eval_pytorch_$(date +%F)
```

PyTorch mode is a vanilla `lerobot_eval` invocation; the
`make_policy` monkey-patch only runs for `--backend qvac`.

### Long runs

The eval takes ~17 min for 30 episodes. Use `nohup` + `disown` so an
SSH disconnect doesn't kill it:

```bash
nohup python packages/vla/sim/eval_libero_sim.py \
  --backend qvac ... \
  --output_dir=./eval_qvac_today \
  > /tmp/eval_qvac.log 2>&1 < /dev/null & disown

# poll progress:
tail -f /tmp/eval_qvac.log

# wait for completion:
until ! pgrep -f eval_libero_sim > /dev/null; do sleep 30; done
```

---

## 5. Reading the output

Each run writes to `--output_dir=…`:

| File | Contents |
|---|---|
| `eval_info.json` | Per-task `successes`, `sum_rewards`, `video_paths` — the source of truth |
| `videos/libero_spatial_<task>/eval_episode_<seed>.mp4` | Front+wrist composite of every episode |

Quick success-rate one-liner:
```bash
python -c "
import json, sys
d = json.load(open(sys.argv[1]))
total = succ = 0
for t in d['per_task']:
    s = t['metrics']['successes']
    print(f'  task {t[\"task_id\"]}: {s} -> {sum(s)}/{len(s)}')
    total += len(s); succ += sum(s)
print(f'  SUMMARY: {succ}/{total} = {100*succ/total:.1f}%')
" ./eval_qvac_today/eval_info.json
```

---

## 6. Comparing two runs

Same seeds, same env, same noise sequence — so within a single eval
the F32-vs-Q8-vs-PyTorch comparison is direct, episode-for-episode.

Typical workflow to compare two GGUFs (env vars `F32_GGUF`,
`Q8_GGUF` set to the local paths you want to score):

```bash
# 1) F32 baseline
pkill -f 'server.js' || true
QVAC_VLA_MODEL=$F32_GGUF \
    nohup setsid bare packages/vla/sim/server/server.js \
    > /tmp/vla-server.log 2>&1 < /dev/null & disown
until curl -s --max-time 2 http://127.0.0.1:8765/info | grep -q chunkSize; do sleep 2; done
python packages/vla/sim/eval_libero_sim.py --backend qvac \
    --policy.path=HuggingFaceVLA/smolvla_libero --env.type=libero --env.task=libero_spatial \
    --eval.n_episodes=3 --eval.batch_size=1 --policy.device=cpu \
    --output_dir=./eval_f32

# 2) Q8 vision
pkill -f 'server.js'
QVAC_VLA_MODEL=$Q8_GGUF \
    nohup setsid bare packages/vla/sim/server/server.js \
    > /tmp/vla-server.log 2>&1 < /dev/null & disown
until curl -s --max-time 2 http://127.0.0.1:8765/info | grep -q chunkSize; do sleep 2; done
python packages/vla/sim/eval_libero_sim.py --backend qvac \
    --policy.path=HuggingFaceVLA/smolvla_libero --env.type=libero --env.task=libero_spatial \
    --eval.n_episodes=3 --eval.batch_size=1 --policy.device=cpu \
    --output_dir=./eval_q8

# 3) PyTorch reference
pkill -f 'server.js' || true   # cleanup
python packages/vla/sim/eval_libero_sim.py --backend pytorch \
    --policy.path=HuggingFaceVLA/smolvla_libero --env.type=libero --env.task=libero_spatial \
    --eval.n_episodes=3 --eval.batch_size=1 --policy.device=cuda \
    --output_dir=./eval_pytorch
```

Then summarize each `eval_info.json` with the one-liner above.

---

## 7. Most recent measured numbers

libero_spatial, 30 episodes, NVIDIA RTX 4000 SFF Ada
(QVAC backend uses Vulkan; PyTorch backend uses CUDA):

| Backend / GGUF | Success | Eval wall | File size |
|---|---|---|---|
| QVAC F32 (`smolvla-libero-f32-fixed.gguf`) | 18/30 = 60.0 % | 1259 s | 2230 MB |
| QVAC Q8 vision (`smolvla-libero-vision-q8.gguf`) | **21/30 = 70.0 %** | 1124 s | 1889 MB |
| PyTorch (CUDA) | 21/30 = 70.0 % | 969 s | — |

All three numbers fall within the 1-σ Wilson interval at n=30 (~8 pp),
so they are statistically equivalent. Practical reading: Q8 vision is
a free 15 % size win with no measurable accuracy cost vs F32 GGUF or
PyTorch.

---

## 8. Troubleshooting

**`POST /predict failed: 500`** — server is up but the GGUF mismatches
the policy config (e.g. wrong action dim). Check
`/tmp/vla-server*.log` for tensor-shape errors.

**`Failed to connect to 127.0.0.1:8765`** — server isn't running. Start
it (see §3) and wait for `/info` to return 200.

**`vla-server: QVAC_VLA_MODEL env var is required`** — `server.js` no
longer carries a default GGUF path; pass the GGUF location via the env
var when launching.

**`SyntaxError: invalid syntax` from lerobot** — you're on the wrong
Python. Use 3.12; lerobot 0.5.2 uses PEP 695 generics that older
interpreters can't parse.

**`MUJOCO_GL` errors / black frames** — `export MUJOCO_GL=egl` in the
shell that runs the eval driver. lerobot's eval doesn't set it for
you.

**SSH drops mid-eval** — always run with `nohup … & disown` and tail
`/tmp/eval_*.log`. The Python process survives.

**`Cannot find module '@qvac/vla'` from server.js** — run
`npm install` in `packages/vla/sim/server/` first.
