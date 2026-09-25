const handwrittenPaths = ['example/', 'examples/', 'node_modules/', 'scripts/', 'src/', 'test/']

export function isHandwritten (filePath) {
  return handwrittenPaths.some(
    (handwrittenPath) =>
      filePath === handwrittenPath || filePath.startsWith(handwrittenPath)
  )
}
