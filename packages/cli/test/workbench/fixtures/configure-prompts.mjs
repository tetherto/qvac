import {
  input,
  select,
  search,
  confirm,
  editor
} from '../../../dist/lib/configure/prompt-adapter.js'
import { emitKeypressEvents } from 'node:readline'
const mode = process.argv[2]
try {
  if (mode === 'bounds') {
    const chosen = await search({
      message: 'BOUNDED prompt',
      pageSize: 30,
      source: (term) =>
        Array.from({ length: 10 }, (_, i) => ({
          name: `${term || 'old'} result ${i} with a very long label that wraps repeatedly`,
          value: i,
          description: `Description ${term || 'old'}\n` + 'extra preview\n'.repeat(30)
        }))
    })
    console.log('RESULT ' + chosen)
  } else if (mode === 'flow') {
    const picked = await select({
      message: 'CHOOSE',
      pageSize: 3,
      choices: Array.from({ length: 10 }, (_, i) => ({
        name: `Choice ${i}`,
        value: i,
        description: `Preview ${i}`
      }))
    })
    const found = await search({
      message: 'SEARCH',
      pageSize: 3,
      source: (term) =>
        Array.from({ length: 5 }, (_, i) => ({
          name: `${term || 'all'} result ${i}`,
          value: `${term}:${i}`,
          description: `Description ${term || 'all'}`
        }))
    })
    const value = await input({
      message: 'INPUT',
      default: 'old value',
      validate: (value) => value === 'good' || 'Must say good'
    })
    const yes = await confirm({ message: 'CONFIRM', default: true })
    console.log('RESULT ' + JSON.stringify({ picked, found, value, yes, raw: process.stdin.isRaw }))
  } else if (mode === 'cancel') {
    const controller = new AbortController()
    emitKeypressEvents(process.stdin)
    const onKey = (_, key) => {
      if (key?.name === 'escape') controller.abort()
    }
    process.stdin.on('keypress', onKey)
    try {
      await search(
        { message: 'BACK', source: () => [{ name: 'One', value: 1 }] },
        { signal: controller.signal }
      )
    } catch (e) {
      console.log('BACK_RESULT ' + e.name)
    } finally {
      process.stdin.off('keypress', onKey)
    }
    await input({ message: 'CANCEL' })
  } else if (mode === 'default') {
    const value = await input({ message: 'DEFAULT', default: 'kept' })
    console.log('RESULT ' + JSON.stringify({ value, raw: process.stdin.isRaw }))
  } else if (mode === 'editor') {
    const value = await editor({ message: 'EDITOR', default: '{"old":true}', postfix: '.json' })
    console.log('RESULT ' + JSON.stringify({ value, raw: process.stdin.isRaw }))
  }
} catch (error) {
  console.log('ERROR ' + error.name + ' ' + error.message + ' RAW ' + process.stdin.isRaw)
}
