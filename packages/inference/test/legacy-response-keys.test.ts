import test from 'brittle'
import { z } from 'zod'
import { legacyResponseFields, withLegacyResponseKeys } from '@/schemas/legacy-response-keys'

test('withLegacyResponseKeys copies each set key under its previous name', (t) => {
  const stats = { totalTime: 100, prefillTotalMs: 7 }
  const result = withLegacyResponseKeys(stats, {
    totalTime: 'total_ms',
    prefillTotalMs: 'prefill_total_ms',
    odeMs: 'ode_ms'
  })
  t.alike(result, { totalTime: 100, prefillTotalMs: 7, total_ms: 100, prefill_total_ms: 7 })
  t.alike(stats, { totalTime: 100, prefillTotalMs: 7 }, 'the input object is left unchanged')
})

test('legacyResponseFields declares each previous name as an optional deprecated field', (t) => {
  const shape = { totalTime: z.number(), backendDevice: z.number().optional() }
  const schema = z.object({
    ...shape,
    ...legacyResponseFields(shape, { totalTime: 'total_ms', odeMs: 'ode_ms' })
  })
  const json = z.toJSONSchema(schema) as {
    properties: Record<
      string,
      { deprecated?: boolean; description?: string; 'x-replaced-by'?: string }
    >
    required?: string[]
  }
  t.is(json.properties['total_ms']?.deprecated, true)
  t.is(json.properties['total_ms']?.['x-replaced-by'], 'totalTime')
  t.is(
    json.properties['total_ms']?.description,
    'Deprecated, removed in the next release. Use `totalTime`.'
  )
  t.absent('ode_ms' in json.properties, 'a key the shape lacks gets no alias')
  t.absent(json.required?.includes('total_ms'), 'the alias is optional')
})
