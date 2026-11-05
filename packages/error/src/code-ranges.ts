export interface CodeRangeAllocation {
  owner: string
  ranges: [number, number][]
  status: 'active' | 'reserved' | 'retired'
  sharedWith?: string[]
  formerOwners?: string[]
  aliases?: Record<string, string[]>
  note?: string
}

export interface CodeRangeRegistry {
  version: 1
  allocations: CodeRangeAllocation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOwner(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isAllocation(value: unknown): value is CodeRangeAllocation {
  if (!isRecord(value) || !isOwner(value.owner)) return false
  if (value.status !== 'active' && value.status !== 'reserved' && value.status !== 'retired') {
    return false
  }
  if (value.note !== undefined && typeof value.note !== 'string') return false
  for (const key of ['sharedWith', 'formerOwners']) {
    const names = value[key]
    if (names !== undefined && (!Array.isArray(names) || !names.every(isOwner))) return false
  }
  if (!Array.isArray(value.ranges) || value.ranges.length === 0) return false
  if (value.aliases !== undefined) {
    if (!isRecord(value.aliases)) return false
    for (const [code, names] of Object.entries(value.aliases)) {
      if (
        !Number.isSafeInteger(Number(code)) ||
        !Array.isArray(names) ||
        names.length < 2 ||
        !names.every(isOwner) ||
        new Set(names).size !== names.length ||
        !value.ranges.some(
          (range: unknown) =>
            Array.isArray(range) && Number(code) >= range[0] && Number(code) <= range[1]
        )
      ) {
        return false
      }
    }
  }
  return value.ranges.every(
    (range: unknown) =>
      Array.isArray(range) &&
      range.length === 2 &&
      Number.isSafeInteger(range[0]) &&
      Number.isSafeInteger(range[1]) &&
      range[0] >= 0 &&
      range[0] <= range[1]
  )
}

// Reservations include unused and retired numbers; registered runtime codes do not.
export function validateCodeRanges(registry: unknown): asserts registry is CodeRangeRegistry {
  if (
    !isRecord(registry) ||
    registry.version !== 1 ||
    !Array.isArray(registry.allocations) ||
    registry.allocations.length === 0
  ) {
    throw new Error('Invalid error code registry: expected version 1 and nonempty allocations')
  }
  const owners = new Set<string>()
  const ranges: { start: number; end: number; owner: string }[] = []
  const allocations: unknown[] = registry.allocations
  for (const allocation of allocations) {
    if (!isAllocation(allocation)) throw new Error('Invalid error code allocation or range bounds')
    if (owners.has(allocation.owner)) throw new Error(`Duplicate owner: ${allocation.owner}`)
    owners.add(allocation.owner)
    for (const [start, end] of allocation.ranges) {
      ranges.push({ start, end, owner: allocation.owner })
    }
  }
  ranges.sort((a, b) => a.start - b.start)
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1]!
    const current = ranges[index]!
    if (current.start <= previous.end) {
      throw new Error(
        `Error code ranges overlap: ${previous.owner} ${previous.start}-${previous.end} and ${current.owner} ${current.start}-${current.end}`
      )
    }
  }
}

export function validatePackageCodes(
  registry: unknown,
  owner: string,
  codes: Readonly<Record<string, number>>
): void {
  validateCodeRanges(registry)
  const allocations = registry.allocations.filter(
    (allocation) =>
      allocation.status !== 'retired' &&
      (allocation.owner === owner || allocation.sharedWith?.includes(owner))
  )
  if (!allocations.length) throw new Error(`No active reservation for ${owner}`)
  const seen = new Map<number, string>()
  for (const [name, code] of Object.entries(codes)) {
    if (
      !Number.isSafeInteger(code) ||
      !allocations.some((allocation) =>
        allocation.ranges.some(([start, end]) => code >= start && code <= end)
      )
    ) {
      throw new Error(`${owner}.${name}: ${code} is outside its reserved ranges`)
    }
    for (const allocation of allocations) {
      for (const [reservedCode, aliases] of Object.entries(allocation.aliases ?? {})) {
        if (aliases.includes(name) && code !== Number(reservedCode)) {
          throw new Error(
            `${owner}.${name}: alias must retain code ${reservedCode}, received ${code}`
          )
        }
      }
    }
    if (seen.has(code)) {
      throw new Error(`${owner}: duplicate code ${code} (${seen.get(code)}, ${name})`)
    }
    seen.set(code, name)
  }
}
