/**
 * Sample cut lines for the checks that need a page from one.
 *
 * Several build checks assert against a page of a cut line, because a line is
 * the layout the version-less paths do not exercise. Which line is immaterial
 * to what they cover, so they read it from the manifest instead of naming it:
 * a cut moves the group and a retirement drops the oldest lines, and a check
 * naming either would fail on the move rather than on the behaviour.
 */

import {
  DOCUMENTED_SOFTWARE,
  isCurrentLineFolder,
} from '../../src/lib/versions.js';

/**
 * The newest plain line folders of a versioned collection, newest first, at
 * most `count` of them. Fewer are returned when the collection carries fewer,
 * so a caller asking for two gets one rather than an undefined entry.
 */
export function cutLineFolders(collectionPath: string, count = 1): string[] {
  const software = DOCUMENTED_SOFTWARE.find(
    (entry) => entry.path === collectionPath && entry.kind === 'collection',
  );
  if (!software) {
    throw new Error(`'${collectionPath}' is not a versioned collection.`);
  }
  return software.versions
    .filter((entry) => !isCurrentLineFolder(entry.folder))
    .slice(0, count)
    .map((entry) => entry.folder);
}
