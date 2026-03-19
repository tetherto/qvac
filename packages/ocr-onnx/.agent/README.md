# .agent/ — Agent-First Development Framework

Canonical source for agent config used by both **Claude Code** and **Cursor**. Run `/setup` after cloning to install everything.

## Quick Start

```bash
git clone https://github.com/tetherto/qvac
cd qvac                            # any directory within the repo works
claude                             # or cursor, or any supported tool
/setup all                         # or: /setup claude, /setup cursor
/orchestrate <task>                # run full pipeline for an Asana task
```

The `<task>` argument accepts an Asana task ID or full URL:
- `1213560067347874`
- `https://app.asana.com/0/1234567890/1213560067347874`

## Directory Layout

```
<repo-root>/                       # Git repository root (git rev-parse --show-toplevel)
├── .agent-handoff/                # Ephemeral handoff workspace (gitignored, created by setup)
├── .claude/                       # Generated Claude Code config (gitignored, created by setup)
├── .cursor/                       # Generated Cursor config (gitignored, created by setup)
└── packages/ocr-onnx/             # (or wherever .agent/ lives in the monorepo)
    └── .agent/                    # Canonical agent config (this directory)
        ├── README.md              # This file
        ├── conduct.md             # Behavioral rules for all agents
        ├── config.json            # Tool registry + role assignments (empty roles by default)
        ├── config-sample.json     # Sample config with recommended multi-tool roles
        ├── mcp.json               # Shared MCP server definitions (Asana)
        ├── settings.json          # Canonical settings (permission allowlist)
        ├── setup.sh               # Generates .claude/ and .cursor/ at the repo root
        ├── agents/                # Agent definitions
        │   ├── plan-reviewer.md
        │   ├── implementer.md
        │   ├── test-writer.md
        │   ├── ci-validator.md
        │   ├── code-reviewer.md
        │   ├── model-registry-updater.md
        │   └── android-runner.md
        ├── knowledge/             # Domain knowledge docs (loaded on-demand)
        │   ├── ci-validation.md
        │   ├── vcpkg-management.md
        │   ├── llama-cpp-android.md
        │   └── registry-models.md
        └── skills/                # Skills (directory-based, SKILL.md format)
            ├── orchestrate/
            ├── release/
            ├── ci-validate/
            ├── commit-trace/
            └── handoff/
```

`setup.sh` resolves the git repo root via `git rev-parse --show-toplevel` and writes generated files there. This ensures both Cursor and Claude Code discover the config regardless of where `.agent/` lives in the repo. Generated files are gitignored — edit sources in `.agent/` instead.

## Tool Compatibility

Not all features work identically in both tools:

| Feature | Claude Code | Cursor |
|---|---|---|
| Skills (`/release`, `/ci-validate`, `/commit-trace`) | Yes | Yes |
| Knowledge files (CI, vcpkg, etc.) | Yes (`.claude/knowledge/`) | Yes (`.cursor/rules/knowledge/*.mdc`) |
| Conduct rules | Yes (`.claude/agent-conduct.md`) | Yes (`.cursor/rules/agent-conduct.mdc`) |
| MCP (Asana) | Manual setup (`~/.claude/settings.json`) | Auto-generated (`.cursor/mcp.json`) |
| Agent definitions (implementer, reviewer, etc.) | Yes (`.claude/agents/`, named launch) | Partial (`.cursor/rules/agents/*.mdc`, as Task sub-agent prompts) |
| `/orchestrate` (multi-agent pipeline) | Yes (named agent spawning) | Partial (via Task tool sub-agents, no model control) |
| Model selection per agent (`opus` / `sonnet`) | Yes | No — Cursor Task tool only supports `fast` or inherited default |
| Persistent agent memory | Yes (`memory: project`) | No — sub-agents have no persistent memory |
| `/loop` (CI polling) | Yes (built-in) | No — use `Shell` with `gh run watch` or manual polling |
| Role dispatch (multi-tool) | Yes | Yes |
| `/handoff` receiver | Yes | Yes |

**Cursor users** get skills, knowledge, conduct rules, agent prompts, and Asana MCP. Agent definitions are available as `.mdc` reference prompts that can be passed to `Task(subagent_type="generalPurpose")` sub-agents. The `/orchestrate` pipeline works with modifications — it delegates phases to Task sub-agents instead of named agents. Limitations: no per-agent model selection, no persistent agent memory, no `/loop` built-in.

## Multi-Tool Setup

Assign different agent roles to different tools so Claude Code and Cursor (or other tools) run simultaneously with different responsibilities.

### Initial Setup

Run `/setup all` to configure both tools and create the shared handoff directory:

```bash
/setup all
```

This does three things:
1. Generates tool-specific config at the **git repo root** for Claude Code (`.claude/`) and Cursor (`.cursor/`)
2. Creates `.agent-handoff/` — the shared directory for inter-tool phase delegation
3. Generates tool-specific `/handoff` and `/orchestrate` skills with hardcoded tool identity (so each tool knows who it is when filtering handoff requests)

If you only use one tool, `/setup claude` or `/setup cursor` still works — the `.agent-handoff/` directory is created regardless.

Re-run `/setup all` after pulling changes to `.agent/`. If files have changed, the script reports conflicts and prompts for a strategy (`--force` to overwrite, `--keep` to skip, `--clean` to regenerate). Setup also cleans stale handoff files from `.agent-handoff/`.

### Role Configuration

Edit `.agent/config.json` → `roles` section to assign agents to tools. By default, `roles` is empty (`{}`) — all phases run locally on whichever tool is active. No config changes are needed for the default single-tool workflow.

To enable multi-tool role dispatch, copy the sample config and adjust as needed:

```bash
cp .agent/config-sample.json .agent/config.json
```

The sample (`config-sample.json`) ships with the recommended role assignments:

```json
{
  "roles": {
    "plan-reviewer": ["claude", "cursor"],
    "implementer": "claude",
    "test-writer": "cursor",
    "ci-validator": "cursor",
    "code-reviewer": "claude",
    "model-registry-updater": "cursor",
    "android-runner": "cursor"
  }
}
```

- **String value** (e.g., `"implementer": "claude"`): single tool handles the role
- **Array value** (e.g., `"plan-reviewer": ["claude", "cursor"]`): multi-reviewer consensus mode — each tool runs its own plan-reviewer independently. Only `plan-reviewer` supports array assignment.

#### Why this split?

The recommended assignment routes high-judgment roles to Claude Code and mechanical roles to Cursor:

| Role | Tool | Why |
|---|---|---|
| `plan-reviewer` | Both | Two independent reviewers with different models catch more issues than one. Opus finds architectural flaws; Cursor's default model finds practical gaps. |
| `implementer` | Claude | Most capability-demanding role. Benefits from Opus (complex reasoning), named agents (isolated context), and persistent memory (learns codebase patterns). |
| `code-reviewer` | Claude | Opus catches subtle bugs and security issues that cheaper models miss. Persistent memory remembers past review patterns. |
| `test-writer` | Cursor | Follows existing test patterns mechanically. Default model is sufficient. Frees Claude's context for higher-judgment work. |
| `ci-validator` | Cursor | Mostly waiting and log parsing. Loses `/loop` but `gh run watch` is a functional substitute. |
| `model-registry-updater` | Cursor | Procedural — follows registry format from knowledge docs. No special model needed. |
| `android-runner` | Cursor | Shell-heavy device interaction. No special model needed. |

To customize, edit `.agent/config.json` directly. Both Claude Code (`claude -p`) and Cursor (`cursor-agent -p --trust`) have headless CLIs, so all handoffs are auto-invoked regardless of which tool is assigned.

### User Workflow

1. Open both Claude Code and Cursor in the same repo
2. Run `/setup all` in either tool (only needed once, or after pulling `.agent/` changes)
3. Edit `.agent/config.json` to assign roles (or copy from `config-sample.json` — see above)
4. Run `/orchestrate <task>` in the orchestrating tool (typically Claude Code — it has the most capabilities)
5. When the orchestrator reaches a phase assigned to another tool, it auto-invokes that tool's CLI in the background — no user action needed
6. The receiving tool executes the agent, pushes commits, writes a result file
7. The orchestrator detects the result, pulls commits, and continues the pipeline

**User interaction**: The only user interaction points are in **Phase 0.5 (reviewer feedback rounds + plan approval)**. All other phases — including all cross-tool handoffs — run automatically via CLI auto-invocation.

### When to Use Multi-Tool vs Single-Tool

Multi-tool is opt-in (`roles: {}` = single-tool). The handoff protocol adds overhead, so it's not always worth it.

**Multi-tool benefits:**
- **Parallelism** — phases on different tools can overlap, cutting wall-clock time on long pipelines
- **Model diversity** — route Opus to high-judgment work (implementation, review) and cheaper models to mechanical work (tests, CI)
- **Context isolation** — each tool gets a fresh context window per handoff instead of accumulating all phases in one window
- **Independent plan review** — `plan-reviewer: ["claude", "cursor"]` runs two reviewers with different models/biases simultaneously

**Multi-tool costs:**
- **Handoff latency** — each cross-tool phase adds ~30-60s overhead (commit, push, CLI invocation, checkout, pull)
- **More failure modes** — push failures, heartbeat staleness, CLI crashes, stale files, TOCTOU races on the status lock
- **Config complexity** — `config.json` roles, CLI fields, capability validation vs zero-config single-tool
- **Harder debugging** — errors are in result files on disk, not inline in your terminal

**Use multi-tool when:** the pipeline takes 30+ minutes single-tool, you want independent plan reviewers, or you're cost-optimizing across tool tiers. **Use single-tool when:** the task is small, you want the simplest debugging experience, or you only have one tool set up.

### Capability Warnings

At startup, the orchestrator validates role assignments against tool capabilities. It warns (but does not block) when a tool is missing a preferred capability for its assigned role. There are no hard blocks — the handoff protocol covers all roles.

### Docker Isolation (Recommended)

AI coding tools execute arbitrary shell commands, install packages, and spawn background processes as part of normal operation. Running them directly on the host exposes your system to unintended side effects — stale processes, modified system config, leaked credentials, or dependency pollution. A single Docker container that hosts all tools provides a clean boundary between agent activity and your host environment.

**Architecture**: All tool CLIs run inside one container with the repo bind-mounted from the host. Claude Code (`claude -p`) and Cursor (`cursor-agent -p`) both run headlessly — no GUI or display server required. The container holds all build dependencies (clang, Node, Bare, vcpkg) so the host only needs Docker.

```
┌──────────────────────────────────────────────────┐
│  Host (only needs Docker)                        │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  qvac-dev container                        │  │
│  │                                            │  │
│  │  claude cli  ·  cursor-agent cli            │  │
│  │  clang-19  ·  node 22  ·  bare  ·  vcpkg  │  │
│  │                                            │  │
│  │  /repo/qvac  ← bind mount from host        │  │
│  │    ├── .agent-handoff/                     │  │
│  │    ├── .claude/                            │  │
│  │    └── .cursor/                            │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**Advantages:**

- **Host protection** — agents cannot modify system packages, global configs, or files outside the bind mount. A misbehaving agent that spawns runaway processes or writes to unexpected paths is contained within the container.
- **Dependency pinning** — the Dockerfile locks exact versions of clang, Node, Bare, vcpkg, and other build tools. Every developer and CI runner gets the same environment, eliminating "works on my machine" drift.
- **Simplified host setup** — the host only needs Docker installed. No clang-19, libc++-19-dev, vcpkg, bare, or any other build dependency on the host.
- **Clean state on restart** — stop and restart the container to get a fresh environment. No stale processes, leaked file handles, corrupted caches, or orphaned temp files surviving between sessions.
- **Resource control** — set CPU and memory limits on the container (`--cpus`, `--memory`) to prevent agents from consuming all host resources during intensive builds or inference workloads.
- **Credential isolation** — tokens (`GH_TOKEN`, `HF_TOKEN`, `ASANA_ACCESS_TOKEN`) are passed as environment variables to the container, not stored in host dotfiles where other processes can read them.
- **Reproducible debugging** — when something breaks, the exact container image can be shared or inspected. No need to reconstruct the host environment.

**Example `docker-compose.yml`:**

```yaml
services:
  dev:
    image: qvac-agent:latest
    volumes:
      - .:/repo/qvac
    environment:
      - GH_TOKEN
      - HF_TOKEN
      - ASANA_ACCESS_TOKEN
    cpus: 8
    mem_limit: 16g
    working_dir: /repo/qvac
```

Both tool CLIs (`claude` and `cursor-agent`) run directly inside the container terminal. The orchestrator auto-invokes whichever tool is needed for each phase — no GUI, no display server, no Remote SSH. Both tools share the same filesystem, same git state, and same `.agent-handoff/` directory.

**Caveats:**

- **File permissions** — ensure the container user's UID/GID matches the host user to avoid permission issues on the bind mount (`--user $(id -u):$(id -g)` or matching `USER` in the Dockerfile).
- **GPU access** — for Android runner or inference workloads that need GPU, pass `--gpus all` to the container (requires NVIDIA Container Toolkit on the host).
- **CLI installation** — the Dockerfile must install both CLIs. Claude Code: `npm install -g @anthropic-ai/claude-code`. Cursor: `curl https://cursor.com/install -fsSL | bash` (installs `cursor-agent`).

## Adding New Tools

1. Add a tool entry to `.agent/config.json` → `tools` with capability flags and a `cli` field (set `cli` to the tool's non-interactive CLI command and args, or `null` if the tool has no headless CLI)
2. Add a `setup_<tool>()` function to `setup.sh` (following the pattern of `setup_cursor()`)
3. Assign roles in `.agent/config.json` → `roles`

No changes to the orchestrator or handoff protocol are needed — they work with any tool that has a `cli` field (auto-invoked) or supports the `/handoff` skill (manual fallback). For tools without a skill system or CLI, the user can manually read request files and write result files (or use a future `handoff-helper.sh` scaffold script).

## How Setup Works

`setup.sh` reads source files from `.agent/` and writes generated config to the **git repo root**:

| Source in `.agent/` | Claude Code destination (repo root) | Cursor destination (repo root) |
|---|---|---|
| `conduct.md` | `.claude/agent-conduct.md` | `.cursor/rules/agent-conduct.mdc` (always-applied rule) |
| `knowledge/*.md` | `.claude/knowledge/` | `.cursor/rules/knowledge/*.mdc` (requestable rules) |
| `agents/*.md` | `.claude/agents/` (named agents) | `.cursor/rules/agents/*.mdc` (Task sub-agent prompts) |
| `skills/*/SKILL.md` | `.claude/skills/` | `.cursor/skills/` |
| `settings.json` | `.claude/settings.json` | — (not applicable) |
| `mcp.json` | — (manual `~/.claude/settings.json`) | `.cursor/mcp.json` (reformatted) |

Agent files copied to Cursor have Claude-specific frontmatter (`model`, `color`, `memory`) stripped and `.claude/` path references replaced with Cursor equivalents.

Existing skills in `.cursor/skills/` (addon-changelog, sdk-changelog, etc.) are not managed by setup — they remain as-is.

### Conflict Detection

On re-run, `setup.sh` checks each file before writing:
- **New** (`[N]`): written immediately
- **Unchanged** (`[=]`): skipped
- **Differs** (`[M]`): conflict — reported but not overwritten (default mode)

If conflicts are found, the script exits with code 3 and prints resolution options:
- `--force`: overwrite all differing files
- `--keep`: keep existing files, only write new ones
- `--clean`: delete all setup-managed files (identified by `AUTO-GENERATED` header) and regenerate

## Full Pipeline (`/orchestrate`)

```
Phase 0:    Setup         Parse Asana URL → read task → create feature branch
Phase 0.5:  Plan Review   plan-reviewer agent → review plan (if needed)
Phase 1:    Implement     implementer agent → write code, verify build/tests
Phase 1.5:  Analyze       Auto-detect if tests and CI are needed
Phase 1.75: Test          test-writer agent → add tests (if needed)
Phase 2:    CI            ci-validator agent → cross-platform CI (if native addon)
Phase 3:    Review        code-reviewer agent → review diff, fix issues
Phase 4:    Re-validate   ci-validator agent → re-run CI if reviewer made fixes
Phase 5:    PR            Push branch, create PR, link to Asana
Phase 6:    Report        Summary, mark Asana task complete
```

The orchestrator stops and reports at any failure point. The Asana task is updated with status at every stop.

### When Tests Are Added

| Signal | Tests? |
|---|---|
| New public API / exported functions | Yes |
| New feature with user-facing behavior | Yes |
| Bug fix (regression test) | Yes |
| Asana acceptance criteria describe testable behavior | Yes |
| Refactoring with no behavior change | No |
| Docs / config / CI only | No |
| Implementer already added tests | No |

### When CI Runs

Native addon packages have full CI workflows. See the **CI Package Mapping** table in `.agent/knowledge/ci-validation.md` for the list of 8 packages with CI and their short names.

SDK/TS packages get automatic PR checks via `pr-checks-sdk-pod`. All other packages (simple libraries, docs, config) have no CI triggers.

## Agents

| Agent | Role | Claude Code | Cursor |
|---|---|---|---|
| `plan-reviewer` | Review/analyze plans, identify risks, provide recommendations | Named agent, Opus | `Task(generalPurpose)` + prompt from `.cursor/rules/agents/` |
| `implementer` | Write code, verify build/tests, commit | Named agent, Opus | `Task(generalPurpose)` + prompt from `.cursor/rules/agents/` |
| `test-writer` | Write automated tests for new/changed code | Named agent, Sonnet | `Task(generalPurpose, model="fast")` + prompt |
| `ci-validator` | Trigger CI, monitor, diagnose failures | Named agent, Sonnet | `Task(generalPurpose)` + prompt (no `/loop`) |
| `code-reviewer` | Review diff, find bugs, fix issues | Named agent, Opus | `Task(generalPurpose)` + prompt |
| `model-registry-updater` | Add/update models in the registry | Named agent, Sonnet | `Task(generalPurpose)` + prompt |
| `android-runner` | Deploy and benchmark models on Android | Named agent, Sonnet | `Task(generalPurpose)` + prompt |

**Claude Code**: Each agent runs in isolation with fresh context, named launching, model selection, and persistent project memory.

**Cursor**: Agent prompts are stored as `.mdc` rules in `.cursor/rules/agents/`. To use an agent, read its rule file and pass the content as the `prompt` parameter to `Task(subagent_type="generalPurpose")`. Limitations: no model control (only `fast` or inherited default), no persistent memory across sessions, no `/loop` polling.

## Skills

| Skill | Purpose |
|---|---|
| `/setup <agent>` | Install skills, knowledge, agents for Claude Code or Cursor |
| `/orchestrate <task>` | Full pipeline: implement → test → CI → review → PR |
| `/handoff` | Pick up delegated phases from another tool (inter-tool protocol) |
| `/release <package>` | Release a package to NPM |
| `/ci-validate <package>` | Trigger and monitor CI for a package |

Existing skills in `.cursor/` (addon-changelog, sdk-changelog, etc.) continue to work as before.

## Parallel Execution

For multiple independent tasks, run agents in parallel with non-overlapping file scopes:

```bash
# Wave 1: independent tasks
/orchestrate <task-1>   # Feature A — touches packages/feature-a/
/orchestrate <task-2>   # Feature B — touches packages/feature-b/

# Review diffs from Wave 1 before proceeding

# Wave 2: dependent tasks
/orchestrate <task-3>   # Depends on task-1 and task-2
```

Rules:
- Parallel tasks **must not** modify the same files
- Review diffs between waves — cheapest moment to catch wrong approaches
- Check Asana for agent comments flagging ambiguity

### Git Worktrees for True Parallel Isolation

The single-working-tree approach above requires careful file-scope discipline — if two tasks touch any of the same files, they collide. **Git worktrees** eliminate this constraint by giving each task its own independent working directory backed by the same repository.

```bash
# Create worktrees for each task (from the main checkout)
git worktree add ../qvac-task-1 -b feat/QVAC-100-feature-a
git worktree add ../qvac-task-2 -b feat/QVAC-200-feature-b

# Run setup in each worktree (each gets its own .claude/, .cursor/, .agent-handoff/)
cd ../qvac-task-1 && bash packages/ocr-onnx/.agent/setup.sh all
cd ../qvac-task-2 && bash packages/ocr-onnx/.agent/setup.sh all

# Launch a tool in each worktree and orchestrate independently
# Worktree 1: claude → /orchestrate QVAC-100
# Worktree 2: claude → /orchestrate QVAC-200
```

**Advantages over single-tree parallel execution:**

- **No file-scope constraint** — tasks can freely modify the same files (even the same lines) because each worktree has its own working directory. Conflicts are resolved at merge time, not during development.
- **Independent git state** — each worktree has its own branch, index, and HEAD. One task's commits, stashes, and rebases don't affect the other. No risk of one agent's `git checkout` disrupting another agent's work.
- **Isolated build artifacts** — each worktree has its own `node_modules/`, build output, and native addon caches. Builds in one worktree can't corrupt another's intermediate files or trigger unnecessary rebuilds.
- **Independent handoff state** — each worktree gets its own `.agent-handoff/` directory, so multi-tool handoffs for different tasks don't interfere with each other.
- **Clean rollback** — if a task goes off the rails, delete the worktree (`git worktree remove ../qvac-task-1`) without affecting the main checkout or other tasks. The branch remains in the repository for inspection.
- **Full context windows** — each tool instance starts fresh in its worktree with no accumulated context from other tasks, avoiding the context pollution that degrades agent quality in long sessions.
- **No wave sequencing** — tasks run fully in parallel without needing wave-based dependency ordering. Merge to main when each task is independently complete.

**Disk and setup cost:**

Worktrees share the `.git` object store, so the disk overhead is only the working tree files (no full clone). However, each worktree needs its own `node_modules/` and native build artifacts, which can be significant for native addon packages. For a typical QVAC worktree:

| Component | Approximate size |
|---|---|
| Working tree files (source) | ~50 MB |
| `node_modules/` (after install) | ~200-500 MB per package |
| Native build artifacts (cmake, vcpkg) | ~500 MB - 2 GB per addon |

Run `npm install` and `bare-make generate && bare-make build` in each worktree that needs native builds. Worktrees that only touch TS/SDK packages skip the native build step.

**Combining worktrees with Docker:**

For maximum isolation, run all worktrees inside a single Docker container. Bind-mount the parent directory so the container has access to every worktree and the shared git object store:

```yaml
services:
  dev:
    image: qvac-agent:latest
    volumes:
      - .:/repo/qvac
      - ../qvac-task-1:/repo/qvac-task-1
      - ../qvac-task-2:/repo/qvac-task-2
    working_dir: /repo/qvac
```

Each tool CLI session (`claude` or `cursor-agent`) targets a different worktree path inside the container.

**Cleanup:**

```bash
# List active worktrees
git worktree list

# Remove a worktree after its PR is merged
git worktree remove ../qvac-task-1

# Prune stale worktree metadata (if a worktree directory was deleted manually)
git worktree prune
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Agent stops for permission prompt | Add the operation to `.agent/settings.json`, re-run `/setup` |
| Build gate fails | Check output, fix manually or in new session, re-run |
| Agent modifies wrong files | Make file scopes more explicit in Asana task |
| Agent stops on ambiguity | Answer the question in Asana, re-run |
| CI fails after push | Check `gh run list`; fix if related, note if not |
| Agent can't connect to Asana | See [Asana connection troubleshooting](#asana-connection-troubleshooting) below |
| `gh: command not found` or PR creation fails | See [GitHub CLI troubleshooting](#github-cli-gh-troubleshooting) below |

### Asana Connection Troubleshooting

If `/orchestrate` fails at Phase 0 because the agent cannot read the Asana task (authentication error, empty response, or MCP server not available), follow these steps:

#### 1. Generate a Personal Access Token

1. Go to **https://app.asana.com/0/my-apps**
2. Click **"Create new token"**
3. Name it (e.g. `cursor-agent` or `claude-agent`)
4. Copy the token immediately — it is only shown once

#### 2. Set the token in your environment

Add this to your shell profile (`~/.bashrc`, `~/.zshrc`, or equivalent):

```bash
export ASANA_ACCESS_TOKEN="<your-token>"
```

Reload the shell:

```bash
source ~/.bashrc   # or: source ~/.zshrc
```

#### 3. Tool-specific setup

**Cursor**: The MCP config (`.cursor/mcp.json`) references `${ASANA_ACCESS_TOKEN}` from the environment. After exporting the token, **restart Cursor** (or reload the window) so the MCP server picks it up.

**Claude Code**: Add the token to `~/.claude/settings.json` under the `mcpServers.asana.env` key, or export it in your shell before launching Claude Code.

#### 4. Verify the token works

```bash
curl -s -H "Authorization: Bearer $ASANA_ACCESS_TOKEN" \
  https://app.asana.com/api/1.0/users/me
```

You should see a JSON response with your Asana user info. If you get `401 Unauthorized`, the token is invalid or expired — generate a new one.

#### Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `ASANA_ACCESS_TOKEN` is empty | Token not exported in current shell | Add `export` line to shell profile and reload |
| MCP server not available (Cursor) | Cursor launched before token was set | Restart Cursor after exporting the token |
| MCP server not available (Claude Code) | Token not in `~/.claude/settings.json` | Add token to settings or export in shell |
| `401 Unauthorized` from API | Token expired or revoked | Generate a new token at https://app.asana.com/0/my-apps |
| Agent falls back to WebFetch | MCP server not connected | Verify token is set, restart the tool, re-run `/setup` |

### GitHub CLI (`gh`) Troubleshooting

The `/orchestrate` pipeline uses `gh` to create pull requests and interact with GitHub. If `gh` is not installed or not authenticated, PR creation will fail.

#### 1. Install the latest GitHub CLI

The `gh` package in default OS repos is often outdated. Install from GitHub's official APT repository to get the latest version:

**Debian / Ubuntu:**

```bash
sudo mkdir -p -m 755 /etc/apt/keyrings
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install gh -y
```

**macOS:**

```bash
brew install gh
```

Verify installation:

```bash
gh --version
```

#### 2. Authenticate with SSH

If you use SSH keys for git operations (recommended for this repo's fork-first workflow):

```bash
gh auth login
```

When prompted, select:
1. **GitHub.com**
2. **SSH** as the preferred protocol for git operations
3. Select your existing SSH key (or let `gh` generate one)
4. **Login with a web browser** — this opens a browser to complete the OAuth flow

Verify authentication:

```bash
gh auth status
```

You should see output like:

```
github.com
  ✓ Logged in to github.com account <username>
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_****
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'
```

The `repo` scope is required for creating PRs on private repositories.

#### 3. Authenticate non-interactively (CI / headless)

If you cannot open a browser (e.g. remote server, CI), authenticate with a Personal Access Token:

```bash
echo "<your-github-pat>" | gh auth login --with-token
```

The token needs the `repo` scope. Generate one at https://github.com/settings/tokens.

Then set the git protocol to SSH:

```bash
gh config set git_protocol ssh
```

#### Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `gh: command not found` | Not installed or not in PATH | Install from GitHub's official repo (see step 1) |
| `gh version 2.4.0` or similar old version | Installed from default OS repo | Remove and reinstall from GitHub's official APT repo |
| `You are not logged into any GitHub hosts` | Not authenticated | Run `gh auth login` (see step 2) |
| `HTTP 403` or `Resource not accessible` | Token missing `repo` scope | Re-authenticate or generate a new token with `repo` scope |
| PR creation fails with `GraphQL: ...` | Fork not synced or branch not pushed | Push branch first: `git push -u origin HEAD` |
