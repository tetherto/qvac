#!/usr/bin/env python3
"""
QVAC-18612 throwaway migration script.

For each workflow file that the user passes on the command line:
  1) Insert a `label-gate` job at the top of the `jobs:` block (right
     after any existing `authorize`/`authorize-pr` job to preserve
     the order). Idempotent: skips if `label-gate` already present.
  2) For every secret-bearing job in the workflow, prepend `label-gate`
     to its `needs:` list and AND the `if:` expression with
     `needs.label-gate.outputs.authorised == 'true'`. Idempotent.

Detection heuristic for "secret-bearing job":
  - Job has `environment:` set, OR
  - Job body references `${{ secrets.<NAME> }}` for any NAME other than
    GITHUB_TOKEN (which is auto-provisioned per run, not user-managed).

The script uses ruamel.yaml for structural parsing and applies LINE-BASED
edits to the original file content. This preserves comments, formatting,
quoting, and ordering exactly. ruamel.yaml is used only to identify line
ranges and YAML semantics — never to round-trip the whole file.

Usage:
  python3 scripts/migrate_label_gate.py <file1> [<file2> ...]
  python3 scripts/migrate_label_gate.py --dry-run <file1>
  python3 scripts/migrate_label_gate.py --check <file1>     # exit 1 if needs migration

Exit codes:
  0  success (or --check: file is already migrated)
  1  --check: file needs migration but wasn't modified
  2  hard error (parse failure, ambiguous structure, etc.)
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ruamel.yaml import YAML

LABEL_GATE_BLOCK = """\
  label-gate:
    name: Authorise (label-gate)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    outputs:
      authorised: ${{ steps.gate.outputs.authorised }}
    steps:
      - name: Checkout (label-gate action only)
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # 6.0.2
        with:
          sparse-checkout: .github/actions/label-gate
          sparse-checkout-cone-mode: false
      - name: Run label-gate
        id: gate
        uses: ./.github/actions/label-gate
        with:
          github-token: ${{ secrets.PAT_TOKEN }}
"""

# Workflows that MUST NOT be gated by label-gate, even if their jobs touch
# user secrets, because they ARE the gating / labelling / approval machinery
# itself. Gating them creates a deadlock where the verified label can never
# be applied (no signal to reviewers) or the approval status check never
# fires (PR un-mergeable until verified, but verified is meant to follow
# the approval signal).
#
# Add a workflow here only when its sole purpose is to react to PR-meta
# events (review, label, comment) to drive the trust signal that label-gate
# itself depends on.
EXEMPT_WORKFLOWS = frozenset({
    ".github/workflows/approval-worker.yml",
    ".github/workflows/approval-check-worker.yml",
})

GATE_GUARD = "needs.label-gate.outputs.authorised == 'true'"


@dataclass
class JobInfo:
    name: str
    start_line: int  # 0-indexed line number of `<name>:` within `jobs:`
    end_line: int  # exclusive
    block_indent: int  # indentation of `<name>:` (typically 2)
    body_indent: int  # indentation of items under the job (typically 4)
    has_environment: bool
    references_user_secret: bool
    needs_line_idx: Optional[int]  # 0-indexed line of `<body_indent>needs:` if any
    needs_value: object  # parsed value of `needs:` (str, list, or None)
    if_line_idx: Optional[int]  # 0-indexed line of `<body_indent>if:` if any
    if_value: Optional[str]  # parsed value of `if:` (string scalar)


def detect_secret_bearing(job_text: str) -> tuple[bool, bool]:
    """Return (has_environment, references_user_secret).

    A job is "secret-bearing" if it explicitly sets `environment:` (gates on a
    GitHub Environment, which can hold environment secrets), OR it consumes a
    user-managed secret in any of three forms:

      ${{ secrets.<NAME> }}     — direct expression
      secrets: inherit          — reusable-workflow forward of all caller secrets
      secrets:\\n  <NAME>: ...   — explicit per-call mapping for `uses:` reusable
    """
    has_env = bool(re.search(r"^\s+environment\s*:\s*\S", job_text, re.MULTILINE))
    secret_refs = re.findall(r"\$\{\{\s*secrets\.([A-Za-z_][A-Za-z_0-9]*)", job_text)
    references_user_secret = any(name != "GITHUB_TOKEN" for name in secret_refs)
    if not references_user_secret:
        if re.search(r"^\s+secrets\s*:\s*inherit\s*$", job_text, re.MULTILINE):
            references_user_secret = True
    if not references_user_secret:
        # Match `secrets:` followed (possibly after blank/comment lines) by an
        # indented child key — i.e. a non-empty mapping. We don't try to enumerate
        # the keys; if any are present, this is a user-secret pass-through.
        # Use [ \t]* (horizontal whitespace only) inside the inner alternation
        # so each iteration consumes exactly one line; `\s*` would let
        # newlines overlap and trigger exponential backtracking on long
        # blank runs (CodeQL py/redos).
        if re.search(
            r"^(\s+)secrets[ \t]*:[ \t]*\n(?:[ \t]*\n|[ \t]*#[^\n]*\n)*\1[ \t]+\S",
            job_text,
            re.MULTILINE,
        ):
            references_user_secret = True
    return has_env, references_user_secret


def find_jobs_block_line(lines: list[str]) -> int:
    """Return the 0-indexed line number of `jobs:`."""
    for i, line in enumerate(lines):
        if re.match(r"^jobs\s*:\s*$", line):
            return i
    raise ValueError("could not find `jobs:` line")


def find_job_line_ranges(lines: list[str], jobs_block_indent: int = 2) -> list[tuple[str, int, int]]:
    """
    Walk `lines` and return [(job_name, start_idx, end_idx_exclusive), ...]
    for every top-level job under `jobs:`. Detects job entries by an
    indented `<name>:\\n` at exactly `jobs_block_indent` spaces.
    """
    jobs_line = find_jobs_block_line(lines)
    job_pat = re.compile(r"^( {%d})([A-Za-z_][A-Za-z_0-9-]*)\s*:\s*$" % jobs_block_indent)
    starts: list[tuple[str, int]] = []
    for i in range(jobs_line + 1, len(lines)):
        line = lines[i]
        # End of jobs block: a line at column 0 that's a key (or end-of-file).
        if line and not line.startswith(" ") and not line.startswith("\t") and line.strip():
            break
        m = job_pat.match(line)
        if m:
            starts.append((m.group(2), i))
    out: list[tuple[str, int, int]] = []
    for idx, (name, start) in enumerate(starts):
        end = starts[idx + 1][1] if idx + 1 < len(starts) else len(lines)
        # Trim trailing blank lines from the job range (keep them with NEXT job/EOF instead)
        while end > start + 1 and not lines[end - 1].strip():
            end -= 1
        out.append((name, start, end))
    return out


def parse_jobs(text: str) -> dict:
    yaml = YAML(typ="safe")
    yaml.allow_duplicate_keys = False
    return yaml.load(text)


def collect_jobs_info(lines: list[str], parsed: dict) -> list[JobInfo]:
    parsed_jobs = (parsed or {}).get("jobs", {}) or {}
    ranges = find_job_line_ranges(lines)
    out: list[JobInfo] = []
    for name, start, end in ranges:
        if name == "label-gate":
            continue
        job_text = "\n".join(lines[start:end])
        has_env, ref_secret = detect_secret_bearing(job_text)
        body_indent_match = None
        for j in range(start + 1, end):
            m = re.match(r"^( +)\S", lines[j])
            if m:
                body_indent_match = len(m.group(1))
                break
        body_indent = body_indent_match if body_indent_match is not None else 4
        # find needs: and if: lines at body_indent
        needs_idx = None
        if_idx = None
        prefix = " " * body_indent
        for j in range(start + 1, end):
            stripped = lines[j].rstrip()
            if not stripped.startswith(prefix):
                continue
            key = stripped[body_indent:]
            if re.match(r"needs\s*:", key):
                needs_idx = j
            elif re.match(r"if\s*:", key):
                if_idx = j
        parsed_job = parsed_jobs.get(name, {}) or {}
        out.append(
            JobInfo(
                name=name,
                start_line=start,
                end_line=end,
                block_indent=2,
                body_indent=body_indent,
                has_environment=has_env,
                references_user_secret=ref_secret,
                needs_line_idx=needs_idx,
                needs_value=parsed_job.get("needs"),
                if_line_idx=if_idx,
                if_value=parsed_job.get("if"),
            )
        )
    return out


def pluck_block_at(lines: list[str], idx: int) -> tuple[list[str], int]:
    """
    Return (block_lines, block_end_exclusive) for the YAML block
    starting at `idx`. The block includes the key line and any deeper-
    indented continuation lines.
    """
    if idx >= len(lines):
        return [], idx
    head = lines[idx]
    m = re.match(r"^( *)\S", head)
    base = len(m.group(1)) if m else 0
    end = idx + 1
    while end < len(lines):
        l = lines[end]
        if not l.strip():
            end += 1
            continue
        m2 = re.match(r"^( *)\S", l)
        cur = len(m2.group(1)) if m2 else 0
        if cur > base:
            end += 1
            continue
        break
    # Trim trailing blanks back into the block boundary
    while end > idx + 1 and not lines[end - 1].strip():
        end -= 1
    return lines[idx:end], end


def render_needs_with_label_gate(value, body_indent: int) -> list[str]:
    """Return the lines for a `needs:` block that includes label-gate."""
    pad = " " * body_indent
    if value is None:
        return [f"{pad}needs: [label-gate]"]
    if isinstance(value, str):
        if value == "label-gate":
            return [f"{pad}needs: [label-gate]"]
        return [f"{pad}needs: [{value}, label-gate]"]
    if isinstance(value, list):
        names = [str(v) for v in value if v is not None]
        if "label-gate" in names:
            return [f"{pad}needs: [{', '.join(names)}]"]
        names = names + ["label-gate"]
        return [f"{pad}needs: [{', '.join(names)}]"]
    raise ValueError(f"unsupported needs: shape: {type(value).__name__} {value!r}")


def render_if_with_gate(value, body_indent: int) -> list[str]:
    pad = " " * body_indent
    if value is None or (isinstance(value, str) and not value.strip()):
        return [f"{pad}if: {GATE_GUARD}"]
    if isinstance(value, bool):
        # `if: false` is a permanent disable; gating it is a no-op (still
        # never runs). `if: true` collapses to the gate alone. Preserve the
        # explicit literal when false so the disable intent stays loud.
        if value is False:
            return [f"{pad}if: false"]
        return [f"{pad}if: {GATE_GUARD}"]
    if not isinstance(value, str):
        raise ValueError(f"unsupported if: shape: {type(value).__name__} {value!r}")
    # Folded (`>-`) scalars come back with embedded \n. Collapse all
    # whitespace runs (including newlines) into single spaces so we can
    # write the composed expression on a single YAML line.
    val = re.sub(r"\s+", " ", value).strip()
    # If the original is wrapped as `${{ <expr> }}` the wrapper is implicit
    # for `if:` conditions; mixing bare + ${{}} causes GHA to evaluate the
    # whole thing as a string literal (always-true). Strip the outer wrapper
    # only when it spans the entire value -- never strip inner ${{ }}.
    m = re.fullmatch(r"\$\{\{\s*(.+?)\s*\}\}", val)
    if m and m.group(1).count("${{") == m.group(1).count("}}"):
        val = m.group(1)
    if GATE_GUARD in val:
        return [f"{pad}if: {val}"]
    if "||" in val:
        composed = f"{GATE_GUARD} && ({val})"
    else:
        composed = f"{GATE_GUARD} && {val}"
    return [f"{pad}if: {composed}"]


def file_already_migrated(text: str) -> bool:
    return bool(re.search(r"^\s*label-gate\s*:\s*$", text, re.MULTILINE))


def migrate(text: str, *, source_path: Optional[Path] = None) -> tuple[str, list[str]]:
    """Return (new_text, change_log)."""
    log: list[str] = []
    if source_path is not None:
        try:
            rel = source_path.resolve().relative_to(Path.cwd().resolve())
            rel_posix = rel.as_posix()
        except ValueError:
            rel_posix = source_path.as_posix()
        if rel_posix in EXEMPT_WORKFLOWS or source_path.as_posix() in EXEMPT_WORKFLOWS:
            log.append(f"exempt: {rel_posix} is part of label/approval machinery -- skipping")
            return text, log
    if file_already_migrated(text):
        log.append("already migrated -- no changes")
        return text, log

    lines = text.split("\n")
    # Preserve trailing newline behavior
    had_trailing_newline = text.endswith("\n")

    parsed = parse_jobs(text)
    jobs = collect_jobs_info(lines, parsed)

    # No-op when no job in the file consumes user secrets / gates on a
    # GitHub Environment. Inserting label-gate would just add a runtime
    # cost (and a spurious queue slot) for zero security benefit -- nothing
    # downstream `needs:` it. We also exclude jobs that are already hard-
    # disabled (`if: false`); gating them is a no-op (still never runs)
    # and rewriting their `if:` would clobber the explanatory comment that
    # usually accompanies such an intentional disable.
    secret_bearing = [
        j for j in jobs
        if (j.has_environment or j.references_user_secret) and j.if_value is not False
    ]
    if not secret_bearing:
        log.append("no secret-bearing jobs to gate -- skipping (label-gate would be unused)")
        return text, log

    # ---- Pass 1: insert the label-gate job block --------------------------
    jobs_line = find_jobs_block_line(lines)
    # Insert after any pre-existing `authorize` / `authorize-pr` job;
    # otherwise immediately after `jobs:`.
    insert_after = jobs_line
    for j in jobs:
        if j.name in ("authorize", "authorize-pr"):
            insert_after = j.end_line - 1
            log.append(f"inserting label-gate after pre-existing {j.name!r} job")
            break

    block_lines = LABEL_GATE_BLOCK.rstrip("\n").split("\n")
    # Surround the inserted block with at most one blank line on each side.
    # Inserting AFTER `jobs:` itself doesn't need a leading blank (the key
    # already sits above its mapping); inserting AFTER an existing job body
    # does, to visually separate the new peer.
    inserting_after_jobs_key = re.match(r"^jobs\s*:\s*$", lines[insert_after]) is not None
    leading_blank_needed = (not inserting_after_jobs_key) and bool(lines[insert_after].strip())
    next_line = lines[insert_after + 1] if insert_after + 1 < len(lines) else ""
    trailing_blank_needed = bool(next_line.strip())
    insert_block = ([""] if leading_blank_needed else []) + block_lines + ([""] if trailing_blank_needed else [])
    lines = lines[: insert_after + 1] + insert_block + lines[insert_after + 1 :]
    log.append(f"inserted label-gate job block at line {insert_after + 2}")

    # Re-parse after insertion to get fresh line numbers
    new_text = "\n".join(lines)
    parsed = parse_jobs(new_text)
    jobs = collect_jobs_info(lines, parsed)

    # ---- Pass 2: gate every secret-bearing job ----------------------------
    # Walk jobs in REVERSE so line edits don't shift downstream indices.
    edits = 0
    for j in sorted(jobs, key=lambda x: -x.start_line):
        if j.name == "label-gate":
            continue
        if not (j.has_environment or j.references_user_secret):
            continue
        if j.if_value is False:
            # Already hard-disabled; gating wouldn't change runtime semantics.
            continue

        # Compute the patch for `needs:` and `if:`.
        new_needs_lines = render_needs_with_label_gate(j.needs_value, j.body_indent)
        new_if_lines = render_if_with_gate(j.if_value, j.body_indent)

        # Replace existing needs: block (or insert just after job header)
        if j.needs_line_idx is not None:
            old_needs_block, end = pluck_block_at(lines, j.needs_line_idx)
            lines = lines[: j.needs_line_idx] + new_needs_lines + lines[end:]
            log.append(f"job {j.name!r}: replaced needs: ({len(old_needs_block)} -> {len(new_needs_lines)} lines)")
        else:
            insert_at = j.start_line + 1
            lines = lines[:insert_at] + new_needs_lines + lines[insert_at:]
            log.append(f"job {j.name!r}: inserted needs: at line {insert_at + 1}")

        # Re-parse to refresh if_line_idx (since lines just shifted)
        new_text = "\n".join(lines)
        parsed = parse_jobs(new_text)
        jobs_refresh = collect_jobs_info(lines, parsed)
        ji = next((x for x in jobs_refresh if x.name == j.name), None)
        if ji is None:
            raise RuntimeError(f"lost track of job {j.name!r} after needs: edit")

        if ji.if_line_idx is not None:
            old_if_block, end = pluck_block_at(lines, ji.if_line_idx)
            lines = lines[: ji.if_line_idx] + new_if_lines + lines[end:]
            log.append(f"job {j.name!r}: replaced if: ({len(old_if_block)} -> {len(new_if_lines)} lines)")
        else:
            # Insert if: right after the (now-updated) needs: block.
            new_text = "\n".join(lines)
            parsed = parse_jobs(new_text)
            jobs_refresh = collect_jobs_info(lines, parsed)
            ji = next((x for x in jobs_refresh if x.name == j.name), None)
            if ji is None or ji.needs_line_idx is None:
                raise RuntimeError(f"lost track of needs: for job {j.name!r}")
            _, after_needs = pluck_block_at(lines, ji.needs_line_idx)
            lines = lines[:after_needs] + new_if_lines + lines[after_needs:]
            log.append(f"job {j.name!r}: inserted if: at line {after_needs + 1}")
        edits += 1

    new_text = "\n".join(lines)
    if had_trailing_newline and not new_text.endswith("\n"):
        new_text += "\n"
    log.append(f"gated {edits} secret-bearing job(s)")
    return new_text, log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    needs_change = 0
    errors: list[str] = []
    for f in args.files:
        path = Path(f)
        try:
            text = path.read_text()
            new_text, log = migrate(text, source_path=path)
        except Exception as e:
            errors.append(f"{f}: {type(e).__name__}: {e}")
            continue
        changed = new_text != text
        marker = "MIGRATED" if changed else "no-op"
        print(f"== {f} [{marker}] ==")
        for line in log:
            print(f"   - {line}")
        if changed:
            needs_change += 1
            if not args.dry_run and not args.check:
                path.write_text(new_text)

    if errors:
        print("\nERRORS:", file=sys.stderr)
        for e in errors:
            print("  " + e, file=sys.stderr)
        return 2
    if args.check:
        return 1 if needs_change else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
