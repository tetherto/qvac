import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  apiPageFor,
  referenceDirFor,
  releaseNotesPageFor,
} from '../scripts/lib/release-shared';
import { DOCUMENTED_SOFTWARE, getCurrentLine } from '../src/lib/versions';

/**
 * Where a release's generated pages land, and what stops them landing
 * anywhere else.
 *
 * The destination is read rather than passed in, so it follows a cut on its
 * own. The cost of that is that a run for a shipped version would overwrite
 * that release's own record of itself and leave a tree that still builds and
 * still passes. These are the tests that hold the refusal in place.
 *
 * Each block builds its own tree under a temp root, because the answer
 * depends on one thing on disk — whether the collection has a development
 * line yet — and both states have to be covered while only one of them is
 * what this repository is in.
 */

const sdk = DOCUMENTED_SOFTWARE.find(
  (software) => software.path === '/sdk' && software.kind === 'collection',
)!;
const current = getCurrentLine(sdk)!;

/** `v0.20` → `0.20.0`, the version a caller would pass for that line. */
function releaseOf(line: string): string {
  return `${line.replace(/^v/, '')}.0`;
}

/** The line above the one last cut: the version being written. */
const coming = (() => {
  const [major, minor] = current.version.replace(/^v/, '').split('.');
  return `${major}.${Number(minor) + 1}.0`;
})();

/** A root carrying the published lines, and the development line on request. */
function treeWith(development: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'reference-target-'));
  mkdirSync(join(root, 'content', 'docs', 'sdk', current.folder, 'reference'), {
    recursive: true,
  });
  if (development) {
    mkdirSync(join(root, 'content', '_unpublished', 'sdk', 'next', 'reference'), {
      recursive: true,
    });
  }
  return root;
}

describe('a collection with a development line', () => {
  let root: string;
  beforeAll(() => {
    root = treeWith(true);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('resolves the version being written to the development line', () => {
    expect(referenceDirFor(coming, root)).toBe(
      join(root, 'content', '_unpublished', 'sdk', 'next', 'reference'),
    );
  });

  it('resolves every patch of that version to the same folder', () => {
    const [major, minor] = coming.split('.');
    expect(referenceDirFor(`${major}.${minor}.7`, root)).toBe(
      referenceDirFor(`${major}.${minor}.0`, root),
    );
  });

  it('names both pages inside it', () => {
    expect(apiPageFor(coming, root)).toBe(
      join(referenceDirFor(coming, root), 'api.mdx'),
    );
    expect(releaseNotesPageFor(coming, root)).toContain('release-notes.mdx');
  });

  it('refuses the line last cut, which the site serves', () => {
    expect(() => referenceDirFor(releaseOf(current.version), root)).toThrow(
      /has shipped/,
    );
    expect(() => referenceDirFor(releaseOf(current.version), root)).toThrow(
      /never regenerated/,
    );
  });

  it('names the version asked for and the folder to edit instead', () => {
    const shipped = releaseOf(current.version);
    expect(() => referenceDirFor(shipped, root)).toThrow(
      new RegExp(current.version),
    );
    expect(() => referenceDirFor(shipped, root)).toThrow(
      new RegExp(`content/docs/sdk/\\${current.folder.replace(')', '\\)')}`),
    );
  });

  it('refuses a version below the line last cut', () => {
    const older = sdk.versions.find(
      (entry) => entry.version !== current.version,
    )!;
    expect(() => referenceDirFor(releaseOf(older.version), root)).toThrow(
      /has shipped/,
    );
  });

  it('refuses through both page helpers, not only the folder', () => {
    const shipped = releaseOf(current.version);
    expect(() => apiPageFor(shipped, root)).toThrow(/Refusing to write/);
    expect(() => releaseNotesPageFor(shipped, root)).toThrow(/Refusing to write/);
  });
});

describe('a collection with no development line', () => {
  let root: string;
  beforeAll(() => {
    root = treeWith(false);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('refuses every version, since there is nowhere to write', () => {
    expect(() => referenceDirFor(coming, root)).toThrow(/no development line/);
    expect(() => referenceDirFor(releaseOf(current.version), root)).toThrow(
      /no development line/,
    );
  });
});
