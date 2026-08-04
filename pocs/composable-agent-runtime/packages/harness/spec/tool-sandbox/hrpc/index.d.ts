export type WireValue =
  | boolean
  | number
  | string
  | null
  | WireValue[]
  | { [key: string]: WireValue }

type WireFrame = Record<string, WireValue | undefined>

export default class ToolSandboxRPC {
  constructor(stream: object)
  describe(args: WireFrame): Promise<WireFrame>
  configure(args: WireFrame): Promise<WireFrame>
  invoke(args: WireFrame): Promise<WireFrame>
  cancel(args: WireFrame): Promise<WireFrame>
  onDescribe(handler: (request: WireFrame) => Promise<WireFrame>): void
  onConfigure(handler: (request: WireFrame) => Promise<WireFrame>): void
  onInvoke(handler: (request: WireFrame) => Promise<WireFrame>): void
  onCancel(handler: (request: WireFrame) => Promise<WireFrame>): void
}
