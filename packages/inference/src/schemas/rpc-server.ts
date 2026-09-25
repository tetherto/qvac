import { z } from 'zod'

const topicSchema = z.string().trim().min(1).max(256)
export const startRpcServerOptionsSchema = z.object({
  host: z.string().min(1).optional().describe('IPv4 bind address. Defaults to 127.0.0.1.'),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe('TCP port. Omit to allocate a free port.'),
  device: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .optional()
    .describe('Native server devices, in caller order.'),
  cache: z.boolean().optional().describe('Enable the native RPC tensor cache.'),
  threads: z.number().int().positive().optional().describe('Native server thread count.'),
  allowNonLoopbackHost: z
    .boolean()
    .optional()
    .describe(
      'Explicitly allow a non-loopback bind on a trusted private network. This does not authenticate clients.'
    ),
  discoveryTopic: topicSchema
    .optional()
    .describe(
      'Opt in to advertising a ready private IPv4 endpoint under this shared topic. The topic does not authenticate peers.'
    )
})
export const rpcServerInfoSchema = z.object({
  serverId: z.string().min(1),
  url: z.string().min(1),
  runtime: z.literal('in-process'),
  rdmaCapable: z.literal(false)
})
export const startRpcServerRequestSchema = startRpcServerOptionsSchema.extend({
  type: z.literal('startRpcServer')
})
export const startRpcServerResponseSchema = rpcServerInfoSchema.extend({
  type: z.literal('startRpcServer')
})
export const stopRpcServerOptionsSchema = z.object({ serverId: z.string().min(1) })
export const stopRpcServerRequestSchema = stopRpcServerOptionsSchema.extend({
  type: z.literal('stopRpcServer')
})
export const stopRpcServerResponseSchema = z.object({ type: z.literal('stopRpcServer') })
export const discoverRpcServersOptionsSchema = z.object({
  topic: topicSchema.describe(
    'Shared discovery topic. Only use with trusted private-network participants.'
  ),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(30000)
    .optional()
    .describe(
      'Search budget in milliseconds, including TCP probes. Defaults to 5000, at most 30000.'
    )
})
export const rpcServerCandidateSchema = z.object({ url: z.string().min(1) })
export const discoverRpcServersRequestSchema = discoverRpcServersOptionsSchema.extend({
  type: z.literal('discoverRpcServers')
})
export const discoverRpcServersResponseSchema = z.object({
  type: z.literal('discoverRpcServers'),
  servers: z.array(rpcServerCandidateSchema)
})
export type StartRpcServerOptions = z.infer<typeof startRpcServerOptionsSchema>
export type RpcServerInfo = z.infer<typeof rpcServerInfoSchema>
export type StopRpcServerOptions = z.infer<typeof stopRpcServerOptionsSchema>
export type DiscoverRpcServersOptions = z.infer<typeof discoverRpcServersOptionsSchema>
export type RpcServerCandidate = z.infer<typeof rpcServerCandidateSchema>
export type StartRpcServerRequest = z.infer<typeof startRpcServerRequestSchema>
export type StopRpcServerRequest = z.infer<typeof stopRpcServerRequestSchema>
export type DiscoverRpcServersRequest = z.infer<typeof discoverRpcServersRequestSchema>
