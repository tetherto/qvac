/**
 * The patch-series release tooling is retired but kept on disk for reference.
 *
 * These scripts implement the scheme where a version is a `vX.Y.x.mdx` sibling
 * and `src/lib/versions.ts` is regenerated from disk. Versioning is now a
 * documentation line — a folder under its collection — and that file is a
 * hand-edited manifest, so running any of them would overwrite work a human
 * did on purpose.
 *
 * Deleting them is a later decision. Refusing to run them is what stops the
 * two schemes from being half-live at the same time.
 */
/**
 * Declared `void` rather than `never` although it always exits: `never` marks
 * everything after the call unreachable, and TypeScript drops the narrowing
 * these scripts get from their own argument guards, so the call that follows
 * stops compiling.
 */
export function refuseRetiredScript(script: string): void {
  console.error(`${script} is retired and does not run.`);
  console.error('');
  console.error(
    'Versions are now documentation lines. Publishing one is two edits by',
  );
  console.error(
    'hand: the folder under `content/docs/`, and its entry in the manifest',
  );
  console.error(
    'at `src/lib/versions.ts`. `tests/line-structure.test.ts` fails the',
  );
  console.error('build when the two disagree.');
  process.exit(1);
}
