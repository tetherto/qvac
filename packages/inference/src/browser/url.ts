// bare-url stand-in: the browser's URL plus the one helper the engine uses.
export function pathToFileURL(path: string): URL {
  const absolute = path.startsWith('/') ? path : `/${path}`
  return new URL(`file://${absolute.split('/').map(encodeURIComponent).join('/')}`)
}

import { browser } from './globals'

const BrowserURL = browser.URL
export { BrowserURL as URL }
export default { URL: BrowserURL, pathToFileURL }
