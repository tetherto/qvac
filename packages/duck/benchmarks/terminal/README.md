# terminal-bench

`qvac_agent.py` runs [Terminal-Bench 2.0](https://www.tbench.ai) (89 tasks) through the real
`qvac -p` with [Harbor](https://github.com/laude-institute/harbor), inside each task's container,
so a score is what the app does: our instructions, the coding plugin, its skills and the harness.

The agent is what the TUI loads in a project, the task's working folder: the coding workflow and
tools, the skills and plugins, and the shell in its bubblewrap sandbox. Tasks install packages
and edit system files, as leaderboard agents may, so the shell reads the whole container and the
sandbox's `writable` option lets it also write the system folders (`/usr`, `/etc`, `/opt`, `/root`,
`/home`, `/var`, `/srv`, `/tmp`, `/mnt`). The project, the coding shell's one workspace, stays the
task's folder. Leaderboard agents call a hosted model and run only their tool
loop in the container. Ours runs the model there too, from a mounted GPU and model folder, so the
tasks' CPU and memory caps (often 1 CPU, 2 GB) are not enforced (`--cpus ignore --memory ignore`).
A report says so.

## Setup, once per machine

Linux with an NVIDIA GPU, Docker or rootless Podman, and `uv tool install harbor`.

```sh
npm ci && npm run build                     # the CLI the containers mount
qvac models pull Qwen3.6-35B-A3B-UD-Q4_K_M  # into ~/.qvac/models
harbor download terminal-bench@2.0 -o <tasks>
```

The SDK counts a model in a read-only folder as not downloaded, so the containers get a writable
folder of hard links to the models instead, which no task can use to delete the originals:
`cp -al ~/.qvac/models <models>`.

Make one folder with what every container mounts at `/opt/qvac`:

- `bin/node`: this machine's Node. An image with an older glibc than the machine's cannot run it.
- `bin/bwrap.real`: this machine's `bwrap`, and `bin/bwrap`, a script that runs it with
  `LD_LIBRARY_PATH=/opt/qvac/lib`, adds `--unsetenv LD_LIBRARY_PATH --unsetenv LD_PRELOAD` so the
  lines it runs use the image's own libraries, and swaps `--proc <dir>` for `--ro-bind /proc <dir>`
  under rootless Podman, which cannot mount a fresh `/proc`.
- `lib/`: `libcuda.so.1`, `libnvidia-ml.so.1`, `libnvidia-ptxjitcompiler.so.1`, CUDA 13's
  `libcudart.so.13`, `libcublas.so.13` and `libcublasLt.so.13`, `libstdc++.so.6` and
  `libgcc_s.so.1`, and bwrap's `libselinux.so.1`, `libcap.so.2` and `libpcre2-8.so.0`.

## Running

From this folder:

```sh
A=<that folder> M=<models>
mounts=$(python3 - "$A" "$M" "$(cd ../.. && pwd)" <<'PY'
import json, sys
a, models, cli = sys.argv[1:]
bind = lambda s, t, ro=True: dict(type="bind", source=s, target=t, **({"read_only": True} if ro else {}))
gpu = ["/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools"]
print(json.dumps([bind(d, d, False) for d in gpu] + [bind(f"{a}/bin", "/opt/qvac/bin"),
  bind(f"{a}/lib", "/opt/qvac/lib"), bind(cli, "/opt/qvac/cli"), bind(models, "/opt/qvac/models", False)]))
PY
)
PYTHONPATH=. harbor run -p <tasks> -e docker -n 1 --cpus ignore --memory ignore \
  -a qvac_agent:Qvac -m qvac/Qwen3.6-35B-A3B-UD-Q4_K_M --mounts "$mounts" -o <jobs>
```

`-n` is how many tasks run at once; each loads its own copy of the model onto the GPU.

Rootless Podman works through its Docker API (`podman system service`, and `DOCKER_HOST` at its
socket). On Ubuntu 22.04, Podman 3.4 writes networks its packaged CNI plugins cannot read: point
`cni_plugin_dirs` in `~/.config/containers/containers.conf` at upstream plugins 1.x. Where the host
mounts a masked `/proc`, as Docker does, add `pidns = "host"` under `[containers]`.
