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
git checkout -b chore/<slug>-<version>-changelog ORG_REMOTE/release-<slug>-<version>
```

Head must not start with `release-`: the cli / ai-sdk-provider / plugin publish
workflows trigger on push to `release-*` and publish to npm. Full naming:
`qv-sdk-pr-create` → "Release PR branch naming".

1. Bump `package.json` (and `openclaw.plugin.json` when present).
2. Apply planned dep / peer ranges.
3. Follow `qv-sdk-changelog` for this `--package` (lockstep `--base-commit`,
   published-version audit, LLM, prettier, NOTICE). Do not call the generator as a
   shortcut.
4. `--package=sdk` only: `qv-sdk-inference-version` + docs Step 8 from
   `qv-sdk-changelog`. It writes the range from a published engine version, so
   the `inference` release merges and publishes before the SDK draft is promoted.

Commit `chore[notask]: release @qvac/<slug> <version>` — no `[bc]` on the title.
Push to `ORG_REMOTE`.

### 3. Draft release PR

```bash
gh pr create --repo tetherto/qvac --draft \
  --base release-<slug>-<version> \
  --head chore/<slug>-<version>-changelog \
  --title "chore[notask]: release @qvac/<slug> <version>" \
  --body "..."
```

SDK pod template. Body API / Models / Breaking copied from
`changelog/<this version>/`. Note future dep versions if lower npm is not live.
Publish is human-gated.

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
