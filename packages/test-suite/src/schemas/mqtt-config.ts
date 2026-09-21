import { z } from 'zod'

export const mqttConnectionSchema = z.object({
  brokerUrl: z.string().default('mqtt://localhost:1883'),
  username: z.string().optional(),
  password: z.string().optional(),
  caPath: z.string().optional(),
  certPath: z.string().optional(),
  keyPath: z.string().optional(),
  rejectUnauthorized: z.boolean().default(true),
  keepalive: z.number().optional(),
  reconnectPeriod: z.number().optional(),
  connectTimeout: z.number().optional(),
  sessionExpiryInterval: z.number().int().min(1).max(0xfffffffe).optional()
})

export type MqttConnectionConfig = z.infer<typeof mqttConnectionSchema>
