# Prepare cascade (mutating)

Only after `/qv-agent-stack-sync --plan` and confirmed versions.

For each `needs_release` package (dependency order):

### 1. Release line

```bash
git fetch ORG_REMOTE main
git branch release-<slug>-<version> ORG_REMOTE/main
git push -u ORG_REMOTE release-<slug>-<version>
```

Reuse if it exists. Do not force-push.

### 2. Head + metadata

```bash
git checkout -b release/<slug>-<version> ORG_REMOTE/release-<slug>-<version>
```

1. Bump `package.json` (and `openclaw.plugin.json` when present).
2. Apply planned dep / peer ranges.
3. Changelog + NOTICE:

```bash
node scripts/sdk/generate-changelog-sdk-pod.cjs --package=<slug>
```

Author `CHANGELOG_LLM.md`, prettier-check, rebuild aggregate, announcement-post (gitignored), NOTICE. Path map: `scripts/sdk/package-paths.cjs`.

4. `--package=sdk` only: `qv-sdk-bare-sdk-sync` + docs Step 8 from `qv-sdk-changelog`.

Commit `chore[notask]: release @qvac/<slug> <version>` (use `chore[bc|notask]:` when breaking). Push to `ORG_REMOTE`.

### 3. Draft release PR

```bash
gh pr create --repo tetherto/qvac --draft \
  --base release-<slug>-<version> \
  --head release/<slug>-<version> \
  --title "chore[notask]: release @qvac/<slug> <version>" \
  --body "..."
```

SDK pod template. Note future dep versions if lower npm is not live. Publish is human-gated.

### 4. Draft backmerge PR

Run `qv-sdk-backmerge` immediately (do not wait for merge):

- `backmerge/release-<slug>-<version>` from `ORG_REMOTE/main`
- cherry-pick `-x`
- title `chore[skiplog|notask]: backmerge release-<slug>-<version> — …`
- also **draft**; link companion release PR

### 5. Fail-stop

- Non-auto-resolvable conflicts → stop.
- Plan blockers → skip, list under Blocked.
- Never merge or trigger publish.

Open all drafts in one session if useful; merge/promote strictly lower → upper after each npm publish.
