// bare-abort-controller stand-in: the browser's own implementation.
import { browser } from './globals'

const BrowserAbortController = browser.AbortController
const BrowserAbortSignal = browser.AbortSignal
export { BrowserAbortController as AbortController, BrowserAbortSignal as AbortSignal }
export default BrowserAbortController
