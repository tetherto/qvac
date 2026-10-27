# Skills

A skill is a `SKILL.md` the model loads when a task needs it: short instructions, with front matter
that says what it is for and what it needs. `qvac` gives the model the skills of
[`@qvac/skills`](https://www.npmjs.com/package/@qvac/skills) and adds its own. `/skills` lists them
with their readiness.

## Skills the CLI adds

| Skill          | For                                                                                           | Models     |
| -------------- | --------------------------------------------------------------------------------------------- | ---------- |
| `qvac-plugins` | writing a QV.AC harness plugin and turning it on in `qvac.config` (see [Plugins](plugins.md)) | 9B, larger |

They live in [`skills/`](../skills) in this package. Each time Core starts, `qvac` copies them into
your skills folder (below), so a new version of `qvac` replaces them. Edit a copy under another
folder name if you want to keep your changes.

Core gives an agent only the skills turned on for it. In a project, `qvac` turns each of its skills on
for the agent once; turn one off in `/skills` and it stays off.

## Only on 9B and larger

`qvac-plugins` sets the harness's model gate in its front matter:

<!-- prettier-ignore -->
```yaml
metadata: { "openclaw": { "minCapabilityProfile": "high" } }
```

Prettier rewrites that line with single quotes, which is not JSON and drops the gate, so put
`# prettier-ignore` above it in a `SKILL.md`.

`high` is the 9B tier of the model catalog. The harness checks it on every turn against the model
that turn runs on, so picking another model in `/model` takes effect on the next message, with no
restart. On the 2B or 4B the skill is left out of the prompt, and `/skills` shows it as
`incompatible-model`. A model the catalog does not know is not gated.

## Your own skills

Your skills folder is `sdk-home/skills` in your storage folder: `~/.qvac/cli/sdk-home/skills`, or
under `--data-dir`. Each skill is a folder with a `SKILL.md`; the folder name is the skill's name.

```text
~/.qvac/cli/sdk-home/skills/
  release-notes/
    SKILL.md
    references/format.md
```

```markdown
---
name: release-notes
description: Write release notes from the git log in our format.
---

# Release notes

1. Run `git log --oneline <last tag>..HEAD`.
2. Group the commits under Added, Changed, Fixed.
```

Core watches the folder, so a new or changed skill shows up without a restart. `n` in `/skills`
starts one for you. A folder with the name of a bundled skill replaces that skill's instructions
but keeps its grants. A new skill gets no grants of its own: its tool calls ask for approval as
usual. The same `minCapabilityProfile` gate works here, with `low`, `mid`, `high` or `xhigh`.
