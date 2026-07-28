// Compile-time shim so `src/*.ts` can `import ... from './lib/audio-format'`
// and have both the emitted `index.js` (require("./lib/audio-format")) and the
// generated `index.d.ts` resolve to the hand-written package-root
// `lib/audio-format.{js,d.ts}`. No JS is emitted for this .d.ts.
export * from '../../lib/audio-format'
