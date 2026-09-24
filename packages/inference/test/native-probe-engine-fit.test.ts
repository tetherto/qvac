import test from 'brittle'

import { assessFitOf } from '@/resources/model-fit/native-probe/engine-fit'

const result = { status: 'fits', reason: 'fits' }
const fit = () => result as never

// Most engine packages assign `module.exports` wholesale, so an ESM importer
// may see the export only under `default`.
test('the fitter is found under whichever shape the package presents', (t) => {
  t.is(assessFitOf({ assessFit: fit })(undefined as never), result)
  t.is(assessFitOf({ default: { assessFit: fit } })(undefined as never), result)
})

test('a named export wins over the default', (t) => {
  const other = () => ({ status: 'error' }) as never
  t.is(assessFitOf({ assessFit: fit, default: { assessFit: other } })(undefined as never), result)
})

test('a package with no fitter is named rather than called', (t) => {
  for (const mod of [{}, { default: {} }]) {
    try {
      assessFitOf(mod)
      t.fail('expected a package with no fitter to be rejected')
    } catch (error) {
      t.ok(/exposes no assessFit/.test(String(error)))
    }
  }
})
