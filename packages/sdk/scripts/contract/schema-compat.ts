import Ajv2020 from 'ajv/dist/2020'

/**
 * Decides whether every value a JSON Schema accepts is also accepted by
 * another, for the schemas the contract export produces from the Zod schemas.
 *
 * A request stays compatible when the new schema accepts every request the old
 * one accepted: `findIncompatibility(oldRequest, newRequest)`. A response stays
 * compatible when the old schema accepts every response the new one can
 * produce: `findIncompatibility(newResponse, oldResponse)`.
 *
 * Field rules follow what clients do with the wire shapes. A request field the
 * new schema no longer declares is a break: a client that sets it would have it
 * rejected or silently dropped. A new response field is compatible, because
 * clients skip fields they do not know, except in an object marked
 * `x-strict: true`: that object is a strict Zod object, which the JS client
 * rejects unknown fields in, and the Python client mirrors.
 *
 * Only the keywords the contract uses are understood. Any other keyword, or a
 * combination this module cannot decide, counts as incompatible unless both
 * sides are identical: a wrong "compatible" would let a breaking change ship
 * under the same major.
 */

export type Direction = 'request' | 'response'

export type Definitions = Readonly<Record<string, unknown>>

type Node = Record<string, unknown>

const ANNOTATIONS = new Set([
  'title',
  'description',
  'deprecated',
  'examples',
  '$comment',
  'x-enum-varnames',
  // Read by the field rules, not compared as a constraint.
  'x-strict'
])

// Keywords this module compares. Anything else must be identical on both sides.
const UNDERSTOOD = new Set([
  ...ANNOTATIONS,
  '$ref',
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'multipleOf',
  'pattern',
  'format',
  'contentEncoding',
  'default'
])

const REF_PREFIX = '#/$defs/'

interface Side {
  defs: Definitions
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function refName(node: Node): string | undefined {
  const ref = node['$ref']
  return typeof ref === 'string' && ref.startsWith(REF_PREFIX)
    ? ref.slice(REF_PREFIX.length)
    : undefined
}

function resolve(node: unknown, side: Side): { node: unknown; ref: string | undefined } {
  let current = node
  let ref: string | undefined
  for (let depth = 0; depth < 32 && isNode(current); depth++) {
    const name = refName(current)
    if (name === undefined) break
    if (!(name in side.defs)) throw new Error(`unresolved $ref "${REF_PREFIX}${name}"`)
    ref = name
    const { $ref: _ref, ...rest } = current
    const target = side.defs[name]
    current = Object.keys(rest).length > 0 && isNode(target) ? { ...target, ...rest } : target
  }
  return { node: current, ref }
}

// Keywords whose value maps names to schemas. Their keys are field or
// definition names, not keywords, so a field called `description` is kept.
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas'])

// The schema with annotations removed and references inlined, as a stable
// string, so that two schemas that only differ in descriptions compare equal.
function canonical(node: unknown, side: Side, stack: string[] = []): string {
  if (Array.isArray(node)) return `[${node.map((item) => canonical(item, side, stack)).join(',')}]`
  if (!isNode(node)) return JSON.stringify(node)
  const name = refName(node)
  if (name !== undefined) {
    if (stack.includes(name)) return JSON.stringify({ $ref: name })
    return canonical(resolve(node, side).node, side, [...stack, name])
  }
  const keys = Object.keys(node)
    .filter((key) => !ANNOTATIONS.has(key))
    .sort()
  return `{${keys
    .map((key) => {
      const value = node[key]
      const rendered =
        SCHEMA_MAPS.has(key) && isNode(value)
          ? canonicalMap(value, side, stack)
          : canonical(value, side, stack)
      return `${JSON.stringify(key)}:${rendered}`
    })
    .join(',')}}`
}

function canonicalMap(map: Node, side: Side, stack: string[]): string {
  const keys = Object.keys(map).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(map[key], side, stack)}`).join(',')}}`
}

function isAnything(node: unknown): boolean {
  if (node === true) return true
  return isNode(node) && Object.keys(node).every((key) => ANNOTATIONS.has(key))
}

function types(node: Node): Set<string> | undefined {
  const type = node['type']
  if (typeof type === 'string') return new Set([type])
  if (Array.isArray(type)) return new Set(type.filter((t): t is string => typeof t === 'string'))
  return undefined
}

function fixedValues(node: Node): unknown[] | undefined {
  if ('const' in node) return [node['const']]
  if (Array.isArray(node['enum'])) return node['enum']
  return undefined
}

function at(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

function show(path: string): string {
  return path === '' ? 'the value' : `"${path}"`
}

export interface CompatOptions {
  direction: Direction
}

/**
 * Returns why some value valid under `sub` is invalid under `sup`, or
 * `undefined` when every value valid under `sub` is valid under `sup`.
 */
export function findIncompatibility(
  sub: unknown,
  subDefs: Definitions,
  sup: unknown,
  supDefs: Definitions,
  options: CompatOptions
): string | undefined {
  const ajv = new Ajv2020({ strict: false, allErrors: false })
  const validators = new Map<string, (value: unknown) => boolean>()
  // A response is compared new-against-old, so a problem the request wording
  // calls narrowing is a widening of the response.
  const say = (request: string, response: string) =>
    options.direction === 'request' ? request : response

  function accepts(schema: unknown, value: unknown): boolean {
    const key = canonical(schema, { defs: supDefs })
    let validate = validators.get(key)
    if (!validate) {
      const compiled = ajv.compile(
        isNode(schema) ? { ...schema, $defs: supDefs } : (schema as boolean)
      )
      validate = (candidate: unknown) => compiled(candidate) as boolean
      validators.set(key, validate)
    }
    return validate(value)
  }

  function check(
    subNode: unknown,
    supNode: unknown,
    path: string,
    seen: ReadonlySet<string>
  ): string | undefined {
    const subResolved = resolve(subNode, { defs: subDefs })
    const supResolved = resolve(supNode, { defs: supDefs })
    const a = subResolved.node
    const b = supResolved.node
    if (subResolved.ref !== undefined && supResolved.ref !== undefined) {
      // A recursive type compares as compatible on its second visit; the first
      // visit has already compared every keyword it has.
      const pair = `${subResolved.ref}|${supResolved.ref}`
      if (seen.has(pair)) return undefined
      seen = new Set([...seen, pair])
    }

    if (isAnything(b) || a === false) return undefined
    if (b === false) {
      return say(`${show(path)} is no longer accepted`, `${show(path)} can now be present`)
    }
    if (a === true || !isNode(a)) {
      return say(
        `${show(path)} accepted any value and no longer does`,
        `${show(path)} can now be any value`
      )
    }
    if (!isNode(b)) return `${show(path)} cannot be compared`

    if (canonical(a, { defs: subDefs }) === canonical(b, { defs: supDefs })) return undefined

    if (options.direction === 'request' && 'default' in a) {
      if (!('default' in b)) return `the default of ${show(path)} was removed`
      if (JSON.stringify(a['default']) !== JSON.stringify(b['default'])) {
        return `the default of ${show(path)} changed`
      }
    }

    const unknownKeyword = [...Object.keys(a), ...Object.keys(b)].find(
      (key) => !UNDERSTOOD.has(key)
    )
    if (unknownKeyword !== undefined) {
      return `${show(path)} changed and uses "${unknownKeyword}", which this check cannot compare`
    }

    const subUnion = (a['anyOf'] ?? a['oneOf']) as unknown[] | undefined
    if (Array.isArray(subUnion)) {
      const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = a
      for (const branch of subUnion) {
        const merged = isNode(branch) ? { ...rest, ...branch } : branch
        const problem = check(merged, b, path, seen)
        if (problem) return problem
      }
      return undefined
    }

    const supUnion = (b['anyOf'] ?? b['oneOf']) as unknown[] | undefined
    if (Array.isArray(supUnion)) {
      const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = b
      const reasons: string[] = []
      for (const branch of supUnion) {
        const merged = isNode(branch) ? { ...rest, ...branch } : branch
        const problem = check(a, merged, path, seen)
        if (problem === undefined) return undefined
        reasons.push(problem)
      }
      return reasons.length === 1
        ? reasons[0]
        : say(
            `no alternative of ${show(path)} accepts what it accepted before`,
            `${show(path)} can now be a value no old alternative accepts`
          )
    }

    const values = fixedValues(a)
    if (values) {
      const rejected = values.find((value) => !accepts(b, value))
      if (rejected === undefined) return undefined
      const shown = JSON.stringify(rejected)
      return say(`${show(path)} no longer accepts ${shown}`, `${show(path)} can now be ${shown}`)
    }
    if (fixedValues(b)) {
      return say(
        `${show(path)} is now limited to fixed values`,
        `${show(path)} is no longer limited to fixed values`
      )
    }

    const subTypes = types(a)
    const supTypes = types(b)
    if (supTypes) {
      const listed = [...supTypes].join(' or ')
      if (!subTypes) {
        return say(
          `${show(path)} is now limited to ${listed}`,
          `${show(path)} is no longer limited to ${listed}`
        )
      }
      for (const type of subTypes) {
        const allowed = supTypes.has(type) || (type === 'integer' && supTypes.has('number'))
        if (!allowed) {
          return say(`${show(path)} no longer accepts ${type}`, `${show(path)} can now be ${type}`)
        }
      }
    }

    const lower = lowerBoundProblem(a, b, path)
    if (lower) return lower
    const upper = upperBoundProblem(a, b, path)
    if (upper) return upper

    for (const [min, max, label] of [
      ['minLength', 'maxLength', 'length'],
      ['minItems', 'maxItems', 'item count']
    ] as const) {
      const supMin = b[min]
      const subMin = a[min]
      if (typeof supMin === 'number' && !(typeof subMin === 'number' && subMin >= supMin)) {
        return say(
          `the minimum ${label} of ${show(path)} increased`,
          `the minimum ${label} of ${show(path)} decreased`
        )
      }
      const supMax = b[max]
      const subMax = a[max]
      if (typeof supMax === 'number' && !(typeof subMax === 'number' && subMax <= supMax)) {
        return say(
          `the maximum ${label} of ${show(path)} decreased`,
          `the maximum ${label} of ${show(path)} increased`
        )
      }
    }

    if (typeof b['multipleOf'] === 'number') {
      const subStep = a['multipleOf']
      if (typeof subStep !== 'number' || !Number.isInteger(subStep / b['multipleOf'])) {
        return say(
          `${show(path)} must now be a multiple of ${b['multipleOf']}`,
          `${show(path)} is no longer always a multiple of ${b['multipleOf']}`
        )
      }
    }
    for (const key of ['pattern', 'format', 'contentEncoding'] as const) {
      if (key in b && a[key] !== b[key]) return `the ${key} of ${show(path)} changed`
    }

    if ('propertyNames' in b) {
      const problem = check(
        a['propertyNames'] ?? { type: 'string' },
        b['propertyNames'],
        at(path, '<key>'),
        seen
      )
      if (problem) return problem
    }

    const objectProblem = checkObject(a, b, path, seen)
    if (objectProblem) return objectProblem

    if ('items' in a || 'items' in b) {
      const problem = check(a['items'] ?? {}, b['items'] ?? {}, at(path, '[]'), seen)
      if (problem) return problem
    }

    return undefined
  }

  function checkObject(
    a: Node,
    b: Node,
    path: string,
    seen: ReadonlySet<string>
  ): string | undefined {
    const isObject = (node: Node) =>
      'properties' in node || 'required' in node || 'additionalProperties' in node
    if (!isObject(a) && !isObject(b)) return undefined

    const subProps = (isNode(a['properties']) ? a['properties'] : {}) as Node
    const supProps = (isNode(b['properties']) ? b['properties'] : {}) as Node
    const subRequired = new Set(Array.isArray(a['required']) ? (a['required'] as string[]) : [])
    const supRequired = Array.isArray(b['required']) ? (b['required'] as string[]) : []
    const subExtra = a['additionalProperties'] ?? true
    const supExtra = b['additionalProperties'] ?? true

    for (const key of supRequired) {
      if (!subRequired.has(key)) {
        return options.direction === 'request'
          ? `field ${show(at(path, key))} became required`
          : `field ${show(at(path, key))} is no longer always present`
      }
    }

    for (const [key, subProp] of Object.entries(subProps)) {
      if (key in supProps) {
        const problem = check(subProp, supProps[key], at(path, key), seen)
        if (problem) return problem
      } else if (options.direction === 'request') {
        return `field ${show(at(path, key))} was removed`
      } else if (isNode(supExtra) && !isAnything(supExtra)) {
        const problem = check(subProp, supExtra, at(path, key), seen)
        if (problem) return problem
      } else if (b['x-strict'] === true) {
        return `new field ${show(at(path, key))} is in a strict object, which clients reject unknown fields in`
      }
    }

    // An object without `additionalProperties` only tolerates fields it does
    // not declare; clients send and read the declared ones. A typed map
    // (`additionalProperties` with a schema, as `z.record` produces) makes its
    // entries part of the contract, and so does an explicit
    // `additionalProperties: {}` (`z.looseObject`, or `z.record` of unknown
    // values), which promises entries of any value.
    if (!('additionalProperties' in a) || subExtra === false) return undefined
    if (supExtra === false) {
      if (!isAnything(subExtra)) {
        return say(
          `${show(path)} no longer accepts map entries`,
          `${show(path)} can now carry map entries`
        )
      }
      if (options.direction === 'request' || b['x-strict'] === true) {
        return `${show(path)} no longer accepts fields it does not declare`
      }
      return undefined
    }
    // A field the other side now declares was one of these entries before.
    for (const [key, supProp] of Object.entries(supProps)) {
      if (key in subProps) continue
      const problem = check(subExtra, supProp, at(path, key), seen)
      if (problem) return problem
    }
    return check(subExtra, supExtra, at(path, '<extra>'), seen)
  }

  function lowerBoundProblem(a: Node, b: Node, path: string): string | undefined {
    const supMin = b['minimum']
    const supExclusive = b['exclusiveMinimum']
    if (typeof supMin !== 'number' && typeof supExclusive !== 'number') return undefined
    const subMin = typeof a['minimum'] === 'number' ? a['minimum'] : undefined
    const subExclusive =
      typeof a['exclusiveMinimum'] === 'number' ? a['exclusiveMinimum'] : undefined
    const ok =
      typeof supExclusive === 'number'
        ? (subExclusive !== undefined && subExclusive >= supExclusive) ||
          (subMin !== undefined && subMin > supExclusive)
        : (subMin !== undefined && subMin >= (supMin as number)) ||
          (subExclusive !== undefined && subExclusive >= (supMin as number))
    if (ok) return undefined
    return say(
      `the lower bound of ${show(path)} increased`,
      `the lower bound of ${show(path)} decreased`
    )
  }

  function upperBoundProblem(a: Node, b: Node, path: string): string | undefined {
    const supMax = b['maximum']
    const supExclusive = b['exclusiveMaximum']
    if (typeof supMax !== 'number' && typeof supExclusive !== 'number') return undefined
    const subMax = typeof a['maximum'] === 'number' ? a['maximum'] : undefined
    const subExclusive =
      typeof a['exclusiveMaximum'] === 'number' ? a['exclusiveMaximum'] : undefined
    const ok =
      typeof supExclusive === 'number'
        ? (subExclusive !== undefined && subExclusive <= supExclusive) ||
          (subMax !== undefined && subMax < supExclusive)
        : (subMax !== undefined && subMax <= (supMax as number)) ||
          (subExclusive !== undefined && subExclusive <= (supMax as number))
    if (ok) return undefined
    return say(
      `the upper bound of ${show(path)} decreased`,
      `the upper bound of ${show(path)} increased`
    )
  }

  return check(sub, sup, '', new Set())
}
