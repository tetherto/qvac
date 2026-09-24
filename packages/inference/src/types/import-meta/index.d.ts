/**
 * `lib` here is the plain ES set, which declares `ImportMeta` empty. Bare
 * populates `url` the same way every ESM host does.
 */
interface ImportMeta {
  readonly url: string
}
