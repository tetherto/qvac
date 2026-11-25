import test from 'brittle'
import { mountBrowserFileGroup, type BrowserFileMount } from '@/worker/browser-file-mount'

function entry(path: string, name = 'model.gguf'): BrowserFileMount {
  return { path, file: new File(['model'], name) }
}

test('browser worker validates a complete file group before mounting 20x', (t) => {
  const invalidGroups: BrowserFileMount[][] = [
    [],
    [entry('relative/model.gguf')],
    [entry('/.qvac/mounted/group/../model.gguf')],
    [entry('/.qvac/mounted/group/bad\0.gguf')],
    [entry('/.qvac/mounted/group\\model.gguf')],
    [entry('/.qvac/mounted/one/a.gguf'), entry('/.qvac/mounted/two/b.gguf')],
    [entry('/.qvac/mounted/group/a.gguf'), entry('/.qvac/mounted/group/a.gguf')]
  ]

  for (let iteration = 0; iteration < 20; iteration++) {
    for (const group of invalidGroups) {
      const mounted: string[] = []
      t.exception(
        () => mountBrowserFileGroup(group, (path) => mounted.push(path)),
        /Invalid browser file mount|one directory and unique names/
      )
      t.is(mounted.length, 0, `iteration ${iteration + 1}: invalid group mounted nothing`)
    }
  }
})

test('browser worker mounts a valid shard group only after preflight', (t) => {
  const group = [
    entry('/.qvac/mounted/group/model-00001-of-00002.gguf'),
    entry('/.qvac/mounted/group/model-00002-of-00002.gguf')
  ]
  const mounted: string[] = []
  mountBrowserFileGroup(group, (path) => mounted.push(path))
  t.alike(
    mounted,
    group.map(({ path }) => path)
  )
})
