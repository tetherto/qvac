import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
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
 * The destination is read from the manifest rather than passed in, so it
 * follows a cut on its own. The cost of that is that a release documented
 * before its line is cut resolves to the line before it, overwrites a shipped
 * release's own record of itself, and leaves a tree that still builds and
 * still passes. These are the tests that hold the refusal in place.
 */

const sdk = DOCUMENTED_SOFTWARE.find(
  (software) => software.path === '/sdk' && software.kind === 'collection',
)!;
const current = getCurrentLine(sdk)!;

/** `v0.20` → `0.20.0`, the version a caller would pass for that line. */
function releaseOf(line: string): string {
  return `${line.replace(/^v/, '')}.0`;
}

describe('the reference folder a version resolves to', () => {
  it('is the current line, for a version of the current line', () => {
    expect(referenceDirFor(releaseOf(current.version))).toContain(
      `sdk/${current.folder}/reference`,
    );
  });

  it('is the same folder for every patch of that line', () => {
    const [major, minor] = current.version.replace(/^v/, '').split('.');
    expect(referenceDirFor(`${major}.${minor}.7`)).toBe(
      referenceDirFor(`${major}.${minor}.0`),
    );
  });

  it('names both pages inside it', () => {
    const release = releaseOf(current.version);
    expect(apiPageFor(release)).toBe(join(referenceDirFor(release), 'api.mdx'));
    expect(releaseNotesPageFor(release)).toContain('release-notes.mdx');
  });
});

describe('a version that is not the current line', () => {
  /** A line above the current one, which no cut has opened yet. */
  const ahead = (() => {
    const [major, minor] = current.version.replace(/^v/, '').split('.');
    return `${major}.${Number(minor) + 1}.0`;
  })();

  it('is refused when it is ahead, and says which cut is missing', () => {
    expect(() => referenceDirFor(ahead)).toThrow(/has no line yet/);
    expect(() => referenceDirFor(ahead)).toThrow(/cut-line\.ts sdk/);
  });

  it('is refused when it has already shipped', () => {
    const older = sdk.versions.find(
      (entry) => entry.version !== current.version,
    )!;
    expect(() => referenceDirFor(releaseOf(older.version))).toThrow(
      /already shipped/,
    );
  });

  it('names the version asked for and the line that is current', () => {
    expect(() => referenceDirFor(ahead)).toThrow(
      new RegExp(`v${ahead.split('.').slice(0, 2).join('.')}`),
    );
    expect(() => referenceDirFor(ahead)).toThrow(new RegExp(current.version));
  });

  it('refuses through both page helpers, not only the folder', () => {
    expect(() => apiPageFor(ahead)).toThrow(/Refusing to write/);
    expect(() => releaseNotesPageFor(ahead)).toThrow(/Refusing to write/);
  });
});
