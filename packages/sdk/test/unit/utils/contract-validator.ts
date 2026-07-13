import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020'

/**
 * Validates payloads against the committed contract/schema.json, so tests
 * exercise exactly what generated clients consume — not the live Zod schemas.
 */
const schemaDocument = JSON.parse(
  readFileSync(new URL('../../../contract/schema.json', import.meta.url), 'utf8')
) as Record<string, unknown>

const ajv = new Ajv2020({ strict: false })
ajv.addSchema(schemaDocument, 'contract')

export function contractValidate(defName: string, payload: unknown) {
  const validate = ajv.getSchema(`contract#/$defs/${defName}`)
  if (!validate) {
    throw new Error(`No $defs entry "${defName}" in contract/schema.json`)
  }
  const valid = validate(payload) === true
  return { valid, errors: valid ? '' : ajv.errorsText(validate.errors) }
}
