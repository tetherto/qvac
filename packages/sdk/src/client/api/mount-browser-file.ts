import {
  mountBrowserFile as mountFile,
  mountBrowserFiles as mountFiles
} from '@/client/rpc/rpc-client'

/** Mounts a user-selected browser file without copying it into browser storage. */
export async function mountBrowserFile(file: File): Promise<string> {
  return mountFile(file)
}

/** Mounts user-selected browser files together so related files remain siblings. */
export async function mountBrowserFiles(files: readonly File[]): Promise<string[]> {
  return mountFiles(files)
}
