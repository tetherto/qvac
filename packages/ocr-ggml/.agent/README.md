# .agent/ — Agent-First Development Framework

Opt-in pilot for OCR-specific agent configuration used by **Claude Code** and
**Cursor**. It remains scoped to `packages/ocr-ggml` while the team validates its
usability; broader repository adoption can be considered separately.

Repository-wide skills live in `.agents/skills` and are independent of this
framework. Claude Code users install those general skills with `/setup claude`.
Cursor and Codex discover them directly.

## Quick Start

```bash
git clone https://github.com/tetherto/qvac
cd qvac
/setup claude                                      # general repository skills for Claude only
bash packages/ocr-ggml/.agent/setup.sh claude      # opt in to the OCR pilot
/orchestrate <task>                                # run the OCR pipeline from supplied requirements
```

Use `cursor` or `all` instead of `claude` with the package setup script to
install the OCR pilot for those targets. Users who do not want the OCR pilot do
not run the package script.

The `<task>` argument accepts a task description or a path to a local
requirements file.

## Directory Layout

```
.agent/
├── README.md               # This file
├── conduct.md              # Behavioral rules for all agents
├── settings.json           # Canonical settings (permission allowlist)
├── setup.sh                # Installs the opt-in OCR config for Claude or Cursor
├── agents/                 # Agent definitions
│   ├── implementer.md
│   ├── test-writer.md
│   ├── ci-validator.md
│   ├── code-reviewer.md
│   ├── model-registry-updater.md
│   └── android-runner.md
├── knowledge/              # Domain knowledge docs (loaded on-demand)
│   ├── ci-validation.md
│   ├── vcpkg-management.md
│   ├── llama-cpp-android.md
│   └── registry-models.md
└── skills/                 # New skills (directory-based, SKILL.md format)
    ├── orchestrate/
    ├── release/
    ├── ci-validate/
    └── commit-trace/

.agents/skills/setup/       # Canonical bootstrap skill
.claude/skills/setup/       # Tracked Claude bootstrap copy
```

The root `/setup claude` command exposes repository skills in `.claude/` through
local symlinks, or copies on Windows. The package setup script separately copies
OCR-specific agents, knowledge, skills, and configuration into `.claude/` or
`.cursor/`. Generated entries are gitignored. Edit repository skills in
`.agents/skills` and OCR-specific sources in this `.agent` directory.

## Tool Compatibility

Not all features work identically in both tools:

| Feature | Claude Code | Cursor |
|---|---|---|
| Skills (`/release`, `/ci-validate`, `/commit-trace`) | Yes | Yes |
| Knowledge files (CI, vcpkg, etc.) | Yes (`.claude/knowledge/`) | Yes (`.cursor/rules/knowledge/*.mdc`) |
| Conduct rules | Yes (`.claude/agent-conduct.md`) | Yes (`.cursor/rules/agent-conduct.mdc`) |
| Agent definitions (implementer, reviewer, etc.) | Yes (`.claude/agents/`, named launch) | Partial (`.cursor/rules/agents/*.mdc`, as Task sub-agent prompts) |
| `/orchestrate` (multi-agent pipeline) | Yes (named agent spawning) | Partial (via Task tool sub-agents, no model control) |
| Model selection per agent (`opus` / `sonnet`) | Yes | No — Cursor Task tool only supports `fast` or inherited default |
| Persistent agent memory | Yes (`memory: project`) | No — sub-agents have no persistent memory |
| `/loop` (CI polling) | Yes (built-in) | No — use `Shell` with `gh run watch` or manual polling |

**Cursor users** get skills, knowledge, conduct rules, and agent prompts. Agent definitions are available as `.mdc` reference prompts that can be passed to `Task(subagent_type="generalPurpose")` sub-agents. The `/orchestrate` pipeline works with modifications — it delegates phases to Task sub-agents instead of named agents. Limitations: no per-agent model selection, no persistent agent memory, no `/loop` built-in.

## How Setup Works

The explicit `packages/ocr-ggml/.agent/setup.sh` command installs only these OCR
pilot assets:

| Source | Claude Code destination | Cursor destination |
|---|---|---|
| `conduct.md` | `.claude/agent-conduct.md` | `.cursor/rules/agent-conduct.mdc` (always-applied rule) |
| `knowledge/*.md` | `.claude/knowledge/` | `.cursor/rules/knowledge/*.mdc` (requestable rules) |
| `agents/*.md` | `.claude/agents/` (named agents) | `.cursor/rules/agents/*.mdc` (Task sub-agent prompts) |
| `skills/*/SKILL.md` | `.claude/skills/` | `.cursor/skills/` |
| `settings.json` | `.claude/settings.json` | — (not applicable) |

Agent files copied to Cursor have Claude-specific frontmatter (`model`, `color`,
`memory`) stripped and `.claude/` path references replaced with Cursor
equivalents. See [`docs/agent-skills.md`](../../../docs/agent-skills.md) for the
separate repository-wide skill setup and Claude link migration behavior.

## Full Pipeline (`/orchestrate`)

```
Phase 0:    Setup         Read supplied requirements → create feature branch
Phase 1:    Implement     implementer agent → write code, verify build/tests
Phase 1.5:  Analyze       Auto-detect if tests and CI are needed
Phase 1.75: Test          test-writer agent → add tests (if needed)
Phase 2:    CI            ci-validator agent → cross-platform CI (if native addon)
Phase 3:    Review        code-reviewer agent → review diff, fix issues
Phase 4:    Re-validate   ci-validator agent → re-run CI if reviewer made fixes
Phase 5:    PR            Push branch, create PR, report PR link in chat
Phase 6:    Report        Summary and completion status in chat
```

The orchestrator stops and reports at any failure point. The current status is reported in chat at every stop.

### When Tests Are Added

| Signal | Tests? |
|---|---|
| New public API / exported functions | Yes |
| New feature with user-facing behavior | Yes |
| Bug fix (regression test) | Yes |
| Supplied acceptance criteria describe testable behavior | Yes |
| Refactoring with no behavior change | No |
| Docs / config / CI only | No |
| Implementer already added tests | No |

### When CI Runs

Native addon packages have full CI workflows. See the **CI Package Mapping** table in `.agent/knowledge/ci-validation.md` for the list of 8 packages with CI and their short names.

SDK/TS packages get automatic PR checks via `pr-checks-sdk-pod`. All other packages (simple libraries, docs, config) have no CI triggers.

## Agents

| Agent | Role | Claude Code | Cursor |
|---|---|---|---|
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
| `/setup claude` | Install general repository skills for Claude Code |
| `bash packages/ocr-ggml/.agent/setup.sh <target>` | Install the opt-in OCR agent framework |
| `/orchestrate <task>` | Full pipeline: implement → test → CI → review → PR |
| `/release <package>` | Release a package to NPM |
| `/ci-validate <package>` | Trigger and monitor CI for a package |

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
- Check chat reports for questions about ambiguous requirements

## Troubleshooting

| Problem | Fix |
|---|---|
| Agent stops for permission prompt | Add the operation to `.agent/settings.json`, rerun the OCR package setup script |
| Build gate fails | Check output, fix manually or in new session, re-run |
| Agent modifies wrong files | Supply explicit file scopes in chat or local requirements |
| Agent stops on ambiguity | Answer the question in chat, re-run |
| CI fails after push | Check `gh run list`; fix if related, note if not |
| `gh: command not found` or PR creation fails | See [GitHub CLI troubleshooting](#github-cli-gh-troubleshooting) below |

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
