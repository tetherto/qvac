'use strict'

const { z } = require('zod')

const baseModelFields = {
  source: z.string().min(1, 'source is required'),
  engine: z.string().min(1, 'engine is required'),
  licenseId: z.string().min(1, 'licenseId is required'),
  description: z.string().max(512).optional(),
  quantization: z.string().max(512).optional(),
  params: z.string().max(64).optional(),
  notes: z.string().max(512).optional(),
  tags: z.array(z.string().max(128)).max(50).optional(),
  deprecated: z.boolean().optional(),
  deprecatedAt: z.string().optional(),
  replacedBy: z.string().optional(),
  deprecationReason: z.string().max(512).optional()
}

const addModelRequestSchema = z.object({
  ...baseModelFields,
  skipExisting: z.boolean().optional()
}).strict()

module.exports = { baseModelFields, addModelRequestSchema }
