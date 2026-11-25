import os from 'bare-os'

/**
 * The Darwin kernel major of this process's OS on macOS and iOS, such as 24
 * on macOS 15 and iOS 18, which share kernel majors. `undefined` on every
 * other platform, or when the kernel release does not parse.
 */
export function getDarwinMajor(
  platform: string | undefined,
  release: () => string = () => os.release()
): number | undefined {
  if (platform !== 'darwin' && platform !== 'ios') return undefined
  const major = /^(\d+)\./.exec(release())?.[1]
  return major === undefined ? undefined : Number(major)
}
