import Ajv2020 from 'ajv/dist/2020'
import { buildContract } from '../../scripts/contract/build-contract'

type JsonSchema = Record<string, unknown>

const contract = buildContract()

/**
 * The contract as `contract:export` writes it and the generated clients read it. The JSON round trip drops undefined
 * values the same way the written files do.
 */
export const contractSchema = JSON.parse(JSON.stringify(contract.schemaDocument)) as {
  $defs: Record<string, JsonSchema>
}
export const contractManifest = JSON.parse(JSON.stringify(contract.manifest)) as {
  methods: { name: string; requestSchema: string }[]
}

const ajv = new Ajv2020({ strict: false })
ajv.addSchema(contractSchema, 'contract')

export function contractValidate(defName: string, payload: unknown) {
  const validate = ajv.getSchema(`contract#/$defs/${defName}`)
  if (!validate) {
    throw new Error(`No $defs entry "${defName}" in contract/schema.json`)
  }
  const valid = validate(payload) === true
  return { valid, errors: valid ? '' : ajv.errorsText(validate.errors) }
}
