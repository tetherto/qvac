// Browser replacement for plugins/builtin/llamacpp-completion/ops/media-content.ts.
// The browser engine takes media as bytes and cannot open a path, so each
// media path, a mounted file or an OPFS file, is read here.
import { normalize, readableFile } from './fs-state'

interface MediaCarrier {
  type?: unknown
  content?: unknown
}

async function readBytes(path: string): Promise<Uint8Array> {
  const file = await readableFile(normalize(path))
  return new Uint8Array(await file.arrayBuffer())
}

async function withBytes<T extends MediaCarrier>(item: T): Promise<T> {
  if (item.type === 'media' && typeof item.content === 'string') {
    return { ...item, content: await readBytes(item.content) }
  }
  return item
}

export async function resolveMediaContent<T>(prompt: T): Promise<T> {
  const messages = prompt as MediaCarrier[]
  return (await Promise.all(
    messages.map(async (message) =>
      Array.isArray(message.content)
        ? { ...message, content: await Promise.all(message.content.map(withBytes)) }
        : withBytes(message)
    )
  )) as T
}
