'use strict'

const { FormatError } = require('./file-cursor')

const MARK = Symbol('mark')
const GLOBALS = new Set([
  'collections.OrderedDict',
  'torch.FloatStorage',
  'torch.HalfStorage',
  'torch._utils._rebuild_tensor',
  'torch._utils._rebuild_tensor_v2'
])

function storage(tuple) {
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 5 ||
    tuple[0] !== 'storage' ||
    !['torch.FloatStorage', 'torch.HalfStorage'].includes(tuple[1]?.global) ||
    typeof tuple[2] !== 'string' ||
    !/^[\w-]+$/.test(tuple[2]) ||
    typeof tuple[3] !== 'string' ||
    !Number.isSafeInteger(tuple[4]) ||
    tuple[4] <= 0
  ) {
    throw new FormatError('unsupported tensor storage')
  }
  return {
    kind: 'storage',
    key: tuple[2],
    type: tuple[1].global === 'torch.FloatStorage' ? 0 : 1,
    count: tuple[4]
  }
}

function reduce(global, args) {
  if (!Array.isArray(args)) throw new FormatError('invalid REDUCE arguments')
  if (global?.global === 'collections.OrderedDict' && args.length === 0) return new Map()
  const version2 = global?.global === 'torch._utils._rebuild_tensor_v2'
  if (
    (!version2 && global?.global !== 'torch._utils._rebuild_tensor') ||
    args.length !== (version2 ? 6 : 4)
  ) {
    throw new FormatError('unsupported REDUCE')
  }
  const [backing, offset, shape, stride] = args
  if (
    backing?.kind !== 'storage' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Array.isArray(shape) ||
    shape.length < 1 ||
    shape.length > 4 ||
    !Array.isArray(stride) ||
    stride.length !== shape.length ||
    (version2 && (typeof args[4] !== 'boolean' || !(args[5] instanceof Map) || args[5].size !== 0))
  ) {
    throw new FormatError('unsupported tensor layout')
  }
  let elements = 1
  for (let index = shape.length - 1; index >= 0; index--) {
    if (!Number.isSafeInteger(shape[index]) || shape[index] <= 0 || stride[index] !== elements) {
      throw new FormatError('tensor is not contiguous')
    }
    elements *= shape[index]
    if (!Number.isSafeInteger(elements)) throw new FormatError('tensor dimensions overflow')
  }
  if (elements > backing.count - offset) throw new FormatError('tensor exceeds storage')
  return { kind: 'tensor', storage: backing, offset, shape }
}

// Interpret the checkpoint's data constructors as inert metadata. No pickle
// global is imported or called, and unrecognised opcodes fail closed.
function parseTorchPickle(bytes) {
  let position = 0
  const stack = []
  const memo = new Map()
  function take(length) {
    if (length < 0 || length > bytes.length - position) throw new FormatError('truncated pickle')
    const result = bytes.subarray(position, position + length)
    position += length
    return result
  }
  function pop() {
    if (stack.length === 0) throw new FormatError('pickle stack underflow')
    return stack.pop()
  }
  function top() {
    if (stack.length === 0) throw new FormatError('empty pickle stack')
    return stack[stack.length - 1]
  }
  function marked() {
    const mark = stack.lastIndexOf(MARK)
    if (mark < 0) throw new FormatError('missing pickle mark')
    const items = stack.splice(mark)
    return items.slice(1)
  }
  function setItems(items) {
    const dict = top()
    if (!(dict instanceof Map) || items.length % 2 !== 0) {
      throw new FormatError('invalid dictionary')
    }
    for (let index = 0; index < items.length; index += 2) {
      const key = items[index]
      if (typeof key !== 'string' || dict.has(key)) {
        throw new FormatError('invalid or duplicate dictionary key')
      }
      dict.set(key, items[index + 1])
    }
  }
  function line() {
    const end = bytes.indexOf(10, position)
    if (end < 0) throw new FormatError('unterminated GLOBAL')
    return take(end - position + 1)
      .subarray(0, -1)
      .toString('utf8')
  }
  if (take(2).compare(Buffer.from([0x80, 2])) !== 0) {
    throw new FormatError('expected pickle protocol 2')
  }
  while (position < bytes.length) {
    const opcode = take(1)[0]
    switch (opcode) {
      case 0x2e: {
        // STOP
        if (position !== bytes.length || stack.length !== 1 || !(top() instanceof Map)) {
          throw new FormatError('invalid pickle result')
        }
        return pop()
      }
      case 0x28:
        stack.push(MARK)
        break
      case 0x7d:
        stack.push(new Map())
        break
      case 0x29:
        stack.push([])
        break
      case 0x4e:
        stack.push(null)
        break
      case 0x88:
        stack.push(true)
        break
      case 0x89:
        stack.push(false)
        break
      case 0x4b:
        stack.push(take(1)[0])
        break
      case 0x4d:
        stack.push(take(2).readUInt16LE(0))
        break
      case 0x4a:
        stack.push(take(4).readInt32LE(0))
        break
      case 0x58:
        stack.push(take(take(4).readUInt32LE(0)).toString('utf8'))
        break
      case 0x63: {
        const name = `${line()}.${line()}`
        if (!GLOBALS.has(name)) throw new FormatError(`unsupported pickle global ${name}`)
        stack.push({ global: name })
        break
      }
      case 0x71:
        memo.set(take(1)[0], top())
        break
      case 0x72:
        memo.set(take(4).readUInt32LE(0), top())
        break
      case 0x68:
      case 0x6a: {
        const key = opcode === 0x68 ? take(1)[0] : take(4).readUInt32LE(0)
        if (!memo.has(key)) throw new FormatError('unknown pickle memo')
        stack.push(memo.get(key))
        break
      }
      case 0x74:
        stack.push(marked())
        break
      case 0x85:
        stack.push([pop()])
        break
      case 0x86: {
        const b = pop()
        stack.push([pop(), b])
        break
      }
      case 0x87: {
        const c = pop()
        const b = pop()
        stack.push([pop(), b, c])
        break
      }
      case 0x73: {
        const value = pop()
        setItems([pop(), value])
        break
      }
      case 0x75:
        setItems(marked())
        break
      case 0x51:
        stack.push(storage(pop()))
        break
      case 0x52: {
        const args = pop()
        stack.push(reduce(pop(), args))
        break
      }
      case 0x62: {
        const state = pop()
        if (!(top() instanceof Map) || !(state instanceof Map)) {
          throw new FormatError('unsupported BUILD')
        }
        break
      }
      default:
        throw new FormatError(`unsupported pickle opcode ${opcode}`)
    }
  }
  throw new FormatError('unterminated pickle')
}

function tensorEntries(root) {
  const tensors = new Map()
  const visited = new Set()
  function collect(dict) {
    if (visited.has(dict)) throw new FormatError('cyclic or shared state dictionary')
    visited.add(dict)
    for (const [name, value] of dict) {
      if (value instanceof Map) collect(value)
      else if (value?.kind === 'tensor') {
        if (tensors.has(name)) throw new FormatError('ambiguous tensor name')
        tensors.set(name, value)
      }
    }
  }
  collect(root)
  if (!tensors.has('conv_first.weight') || !tensors.has('conv_last.weight')) {
    throw new FormatError('checkpoint is not a supported ESRGAN state dictionary')
  }
  return tensors
}

module.exports = { parseTorchPickle, tensorEntries }
