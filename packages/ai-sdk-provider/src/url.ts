/**
 * Remove every trailing `/` from a URL in one backward scan. A regex such as
 * `/\/+$/` retries from each `/` in a run, so it is quadratic on a long run of
 * slashes that is followed by another character.
 */
export function trimTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end--
  return end === url.length ? url : url.slice(0, end)
}
