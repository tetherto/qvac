---
name: qv-agent-stack-sync
description: Plan and prepare the QVAC agent-stack release cascade across @qvac/sdk, @qvac/cli, @qvac/ai-sdk-provider, @qvac/opencode-plugin, and @qvac/openclaw-plugin. Use for /qv-agent-stack-sync --plan, --prepare-cascade, or --promote; syncing CLI to a newer SDK; or checking OpenCode/OpenClaw/provider compatibility.
---

# QVAC Agent Stack Sync

Orchestrate the published dependency cascade:

```text
@qvac/sdk
  -> @qvac/cli
    -> @qvac/ai-sdk-provider
      -> @qvac/opencode-plugin
      -> @qvac/openclaw-plugin
```

Goal: know which packages need a release, prepare draft release + backmerge PRs when asked, never auto-publish. SDK releases still run `qv-sdk-bare-sdk-sync` for lockstep.

## Modes

| Mode | Mutates? | When |
| --- | --- | --- |
| `--plan` (default) | No | Always run first. Cascade matrix + version recommendations. |
| `--prepare-cascade` | Yes (confirm first) | Open **draft** release PRs and **draft** backmerge PRs for `needs_release` packages. |
| `--promote <slug>` | Yes (confirm first) | Mark a draft release PR ready after lower-layer npm is live; re-verify. Does **not** publish. |

Invoke: `/qv-agent-stack-sync` or `/qv-agent-stack-sync --plan`.

## References

- `.cursor/rules/sdk/sdk-pod-packages.mdc` — pod scope + agent-stack order
- `.cursor/skills/qv-sdk-changelog/SKILL.md`
- `.cursor/skills/qv-sdk-pr-create/SKILL.md`
- `.cursor/skills/qv-sdk-backmerge/SKILL.md`
- `.cursor/skills/qv-sdk-bare-sdk-sync/SKILL.md` (sdk releases only)
- `docs/architecture/AGENT-INTEGRATIONS.md`
- `packages/cli/test/AGENT_STACK_E2E.md`
- Planner: `.cursor/skills/_lib/sdk/agent-stack-plan.mjs`
- Path map: `scripts/sdk/package-paths.cjs`
- Cascade details: [references/prepare-cascade.md](references/prepare-cascade.md)

## Version policy (pre-major 0.x)

Recommend with rationale — never silent-bump. Confirm before `--prepare-cascade`.

- `0.x` carets do **not** cross minors (`^0.8.0` ≠ `0.9.0`).
- **Minor** — outstanding `[bc]`, `[api]`, or `feat:` commits.
- **Patch** — dep-range alignment, or other non-breaking outstanding commits (e.g. `fix:`).

## Blockers the plan must surface

- **AI SDK major mismatch** — e.g. provider on `ai@7` while OpenCode still depends on `ai@6` / provider `^0.2.x`. Hold that plugin release until code + deps align.
- Missing git tags vs npm latest — stop and ask; do not guess changelog base.
- Lower layer not on npm yet — drafts may declare future ranges; `--promote` / publish wait on `npm view`.

## Workflow

### 0. Shared preflight

1. Prefer a clean worktree / dedicated worktree for cascade prep.
2. `git fetch` org remote (`upstream` / `tetherto/qvac`) tags + `main`.
3. Identify org remote vs fork remote (same policy as `qv-sdk-pr-create`).

### 1. `--plan` (mandatory first step)

```bash
node .cursor/skills/_lib/sdk/agent-stack-plan.mjs
node .cursor/skills/_lib/sdk/agent-stack-plan.mjs --json
```

Show the markdown table to the user. For each package report:

- local version, npm latest, last tag
- `needs_release` / blocked
- suggested next version + rationale
- dep ranges vs target lower version
- outstanding non-noise commits since tag

**Do not** create branches or PRs in this mode.

### 2. `--prepare-cascade`

Requires explicit user confirmation of the plan (versions + which packages).

Then for each `needs_release` package in dependency order, follow [references/prepare-cascade.md](references/prepare-cascade.md):

1. Create org `release-<slug>-<version>` from `main` if missing.
2. Prep version bump + dep ranges + changelog (`qv-sdk-changelog --package=<slug>`) + NOTICE.
3. Open **draft** release PR → `release-<slug>-<version>`.
4. Open **draft** backmerge PR → `main` (`[skiplog]`, cherry-pick `-x`) in the same session.
5. Skip packages marked blocked; report them clearly.
6. Do **not** merge. Do **not** trigger publish (Dima / human).

SDK releases still chain `qv-sdk-bare-sdk-sync` + docs Step 8 from `qv-sdk-changelog`.

### 3. `--promote <slug>`

1. Confirm lower dependencies are on npm (`npm view`).
2. Fresh-install verification (below).
3. Mark the draft release PR ready for review (and keep backmerge draft until release merges, or ready it alongside — prefer ready both when release is ready to merge).
4. Remind: human merges; human triggers publish; then promote the next upper package.

## File updates (when preparing releases)

### CLI

- `packages/cli/package.json` — version + `dependencies["@qvac/sdk"]`
- changelog via `qv-sdk-changelog --package=cli`
- NOTICE via `qv-notice-generate cli`
- README committed SDK range if documented

### AI SDK Provider

- `packages/ai-sdk-provider/package.json` — version + extend `peerDependencies["@qvac/cli"]`
- changelog + NOTICE via SDK pod tools

### OpenCode / OpenClaw plugins

- `plugins/opencode/package.json` or `plugins/openclaw/package.json` (+ `openclaw.plugin.json` version when present)
- bump `@qvac/cli` and `@qvac/ai-sdk-provider` deps to the planned minors
- OpenCode may also need `ai` / `@ai-sdk/openai-compatible` majors to match the provider — if not aligned, plan marks **blocked**
- changelog: `qv-sdk-changelog --package=opencode-plugin` or `--package=openclaw-plugin` (path map resolves `plugins/*`)
- NOTICE + README compatibility lines

## Verification

### Per package (from package dir)

- CLI: `lint`, `build`, `test:unit`, `test:e2e`, `node scripts/check-publish-ready.cjs`
- Provider: `lint`, `build`, `test:unit` (optional `QVAC_INTEGRATION_TEST=1 npm run test:integration`)
- OpenCode / OpenClaw: `lint`, `build`, `test:unit` (optional integration where available)

### Fresh install (after lower npm publish)

```bash
tmp=$(mktemp -d)
cd "$tmp"
npm init -y
npm install --no-fund --no-audit @qvac/opencode-plugin@latest
npm ls @qvac/opencode-plugin @qvac/ai-sdk-provider @qvac/cli @qvac/sdk
```

Repeat with `@qvac/openclaw-plugin@latest` when promoting OpenClaw.

## Completion report

Always end with:

- plan table (or link to `--json` output)
- packages released / drafted / blocked / skipped
- confirmed versions and dep ranges before → after
- draft release + backmerge PR URLs
- tests run
- reminder that publish is human-gated

## Quality checklist

- [ ] `--plan` run before any mutation
- [ ] User confirmed versions for `--prepare-cascade`
- [ ] OpenClaw included in the cascade
- [ ] Draft release **and** draft backmerge opened together per package
- [ ] Blocked plugins (e.g. AI SDK mismatch) not force-released
- [ ] No publish / workflow_dispatch for npm
- [ ] Org-branch heads preferred (`tetherto/qvac`)
