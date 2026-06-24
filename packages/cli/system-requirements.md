# QVAC system requirements

Minimum host requirements for running `@qvac/sdk` and `@qvac/cli`. You can
validate your environment against this list with:

```bash
qvac doctor
```

Use `--json` for machine-readable output and `--quiet` to only set the exit
code (`0` when all required checks pass, `1` otherwise).

## Scope: CLI host vs. SDK deploy targets

The `qvac` CLI itself runs on desktops only. The QVAC SDK, however, ships
to a broader set of **deploy targets** via BareKit/Expo — including Android
and iOS. `qvac doctor` reports both, in two distinct sections of its output:

- **Runtime → CLI host** — where the `qvac` command can execute. Desktop
  platforms only; this is a `fail` if your shell isn't on a supported host.
- **Deploy targets (SDK)** — the full set of platforms your SDK
  applications can target. Android and iOS appear here, with host
  toolchain checks (`adb`, `xcodebuild`) that indicate whether you can
  actually deploy to those targets from this machine.

## Required

| Requirement | Notes |
|---|---|
| Node.js `>= 18.0.0` | Node 18 is end-of-life; prefer `>= 20`. Matches `engines.node`. |
| Supported CLI host | `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-x64`. The `qvac` CLI cannot run on mobile; those are deploy targets only. |
| Total RAM `>= 2 GB` (recommended `>= 4 GB`) | Below 4 GB, most LLMs will fail to load. |

## Recommended

| Requirement | When it is needed |
|---|---|
| Available RAM `>= 2 GB` | Needed when loading a model. Checked via `os.availableMemory()` on Node 22+, falling back to `os.freemem()` on older Nodes (freemem is known to under-report on Linux/macOS). |
| GPU acceleration (Metal on macOS, Vulkan on Linux/Windows) | QVAC inference backends use Metal (always present on macOS) or Vulkan (`vulkaninfo --summary`) on Linux/Windows. Without a Vulkan ICD, LLM and Whisper inference fall back to CPU and are significantly slower. |
| Free disk `>= 5 GB` in the working directory | Model artifacts are typically multi-GB per model. Uses `fs.statfsSync` (Node 18.15+) with a POSIX `df` fallback. |

## Deploy targets

These checks are informational/recommended — they never cause `qvac doctor`
to exit non-zero, because bundling for any target is always supported via
bare-pack's prebuilt binaries. What's checked here is the host toolchain
needed to install/deploy to each target class.

| Target | Check | Status when missing |
|---|---|---|
| `darwin-{arm64,x64}`, `linux-{arm64,x64}`, `win32-x64` | Listed under the "Desktop" row; native host flagged with `(native)`. | Always `pass` — cross-bundling is built in. |
| `android-arm64` | `adb --version` | `warn` — install [Android platform tools](https://developer.android.com/tools/releases/platform-tools) to deploy to devices. |
| `ios-arm64` + simulators | `xcodebuild -version` (macOS only) | `warn` on macOS without Xcode, `info` on non-macOS hosts (iOS builds require a macOS host). |

## Optional tools

Only required if you use the corresponding feature. The checker warns when
they are missing but does not fail.

| Tool | Required for |
|---|---|
| `ffmpeg` | Microphone capture, transcription examples, and the built-in audio decoder. Install from [ffmpeg.org](https://ffmpeg.org/download.html). |
| [Bare](https://bare.pears.com) runtime | Running the SDK under Bare directly (Node and Bun are supported out of the box). |
| [Bun](https://bun.sh) | Building the SDK from source or running the monorepo development workflow. |

## Project

| Check | Notes |
|---|---|
| `@qvac/sdk` resolvable from project | Resolved with `require.resolve('@qvac/sdk/package.json')` rooted at the working directory, so hoisted installs (monorepos, Yarn/Bun workspaces) are correctly detected. |

## Exit codes

- `0` — all required checks passed. Warnings, skips, and informational
  rows may still be present.
- `1` — one or more required checks failed (unsupported Node version,
  unsupported CLI host, insufficient total RAM, …). See the printed hints
  for remediation steps.

## JSON schema

```ts
interface DoctorReport {
  ok: boolean;
  platform: string;       // e.g. "darwin"
  arch: string;           // e.g. "arm64"
  nodeVersion: string;    // e.g. "20.19.5"
  sections: Array<{
    id: 'runtime' | 'hardware' | 'targets' | 'tools' | 'project';
    title: string;
    checks: Array<{
      id: string;
      label: string;
      status: 'pass' | 'warn' | 'fail' | 'skip' | 'info';
      severity: 'required' | 'recommended' | 'informational';
      value?: string;
      detail?: string;
      hint?: string;      // typically present for any non-pass result
    }>;
  }>;
}
```

### Status semantics

- `pass` — check ran and the requirement is satisfied.
- `warn` — recommended requirement not met, or a deploy-target toolchain
  is missing; does not cause a non-zero exit.
- `fail` — required check not met; causes exit code `1`.
- `skip` — the check could not be executed on this host (missing Node API
  and no fallback, etc.).
- `info` — informational row with no pass/fail judgment (e.g. iOS deploy
  target on a non-macOS host).
