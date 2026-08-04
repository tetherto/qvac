import crypto from '#crypto'

export function hashBundledSkills(files: Readonly<Record<string, string>>): string {
  const hash = crypto.createHash('sha256')
  const sorted = Object.entries(files).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )
  for (const [filePath, content] of sorted) {
    hash.update(filePath)
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function verifyBundledSkillsHash(
  files: Readonly<Record<string, string>>,
  expectedHash: string
): Promise<void> {
  const actualHash = hashBundledSkills(files)
  if (actualHash !== expectedHash) {
    throw new Error(`bundle hash mismatch: expected ${expectedHash}, got ${actualHash}`)
  }
}
